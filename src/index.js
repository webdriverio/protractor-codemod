const SUPPORTED_SELECTORS = ['id', 'model', 'css', 'binding']
const ELEMENT_COMMANDS = ['sendKeys']

class TransformError extends Error {
  constructor(message, path, file) {
    const source = file.source.split('\n')
    const line = source.slice(path.value.loc.start.line - 1, path.value.loc.end.line)[0]
    const expression = line.slice(0, path.value.loc.end.column)
    const errorMsg = `Error transforming ${file.path.replace(process.cwd(), '')}:${path.value.loc.start.line}`
    super(errorMsg)
    this.stack = (
      errorMsg + '\n\n' +
      `> ${expression}\n` +
      ' '.repeat(path.value.callee.loc.start.column + 2) + '^\n\n' +
      'Binding selectors are not supported, please consider refactor this line\n' +
      `  at ${file.path}:${path.value.loc.start.line}:${path.value.loc.start.column}`
    )
    this.name = this.constructor.name
  }
}

function getSelectorArgument (j, path, file) {
  const args = []
  const bySelector = path.value.arguments[0].callee.property.name

  if (bySelector === 'id') {
    args.push(j.literal(`#${path.value.arguments[0].arguments[0].value}`))
  } else if (bySelector === 'model') {
    args.push(j.literal(`*[ng-model="${path.value.arguments[0].arguments[0].value}"]`))
  } else if (bySelector === 'css') {
    args.push(...path.value.arguments[0].arguments)
  } else if (bySelector === 'binding') {
    throw new TransformError('by.binding is not supported anymore', path, file)
  }

  return args
}

function matchesSelectorExpression (path) {
  return (
    path.value.arguments.length === 1 &&
    path.value.arguments[0].callee.type === 'MemberExpression' &&
    path.value.arguments[0].callee.object.name === 'by' &&
    SUPPORTED_SELECTORS.includes(path.value.arguments[0].callee.property.name)
  )
}

function replaceCommands (prtrctrCommand) {
  switch (prtrctrCommand) {
    // element commands
    case 'sendKeys':
      return 'setValue'
    case 'isPresent':
      return 'isExisting'
    // browser commands
    case 'executeScript':
      return 'execute'
    case 'get':
      return 'url'
    case 'wait':
      return 'waitUntil'
    case 'getAllWindowHandles':
      return 'getWindowHandles'
    default: return prtrctrCommand
  }
}

module.exports = function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);
  
  /**
   * transform:
   * element(...)
   * $('...')
   */
  root.find(j.CallExpression)
    .filter((path) => (
      path.value.callee &&
      path.value.callee.type === 'Identifier' &&
      path.value.callee.name === 'element' &&
      matchesSelectorExpression(path)
    ))
    .replaceWith((path) => (
      j.callExpression(
        j.identifier('$'),
        getSelectorArgument(j, path, file)
      )
    ))
  
  /**
   * transform:
   * element.all(...)
   * $$('...')
   */
  root.find(j.CallExpression)
    .filter((path) => (
      path.value.callee &&
      path.value.callee.type === 'MemberExpression' &&
      path.value.callee.object.name === 'element' &&
      path.value.callee.property.name === 'all' &&
      matchesSelectorExpression(path)
    ))
    .replaceWith((path) => j.callExpression(
      j.identifier('$$'),
      getSelectorArgument(j, path, file)
    ))
  
  /**
   * transform browser commands
   */
  root.find(j.CallExpression)
    .filter((path) => (
      path.value.callee &&
      path.value.callee.type === 'MemberExpression' &&
      path.value.callee.object.name === 'browser'
    ))
    .replaceWith((path) => j.callExpression(
      j.memberExpression(
        path.value.callee.object,
        j.identifier(replaceCommands(path.value.callee.property.name))
      ),
      path.value.arguments
    ))
  
  /**
   * transform element commands
   */
  root.find(j.CallExpression)
    .filter((path) => (
      path.value.callee &&
      path.value.callee.type === 'MemberExpression' &&
      ELEMENT_COMMANDS.includes(path.value.callee.property.name)
    ))
    .replaceWith((path) => j.callExpression(
      j.memberExpression(
        path.value.callee.object,
        j.identifier(replaceCommands(path.value.callee.property.name))
      ),
      path.value.arguments
    ))
  
  /**
   * replace await/then calls, e.g.
   * ```
   * await browser.getAllWindowHandles().then(handles => {
   *   browser.switchTo().window(handles[handles.length - 1]);
   * })
   * ```
   * to:
   * ```
   * const handles = await browser.getAllWindowHandles()
   * browser.switchTo().window(handles[handles.length - 1]);
   * ```
   */
  root.find(j.ExpressionStatement)
    .filter((path) => (
      path.value.expression &&
      path.value.expression.type === 'AwaitExpression' &&
      path.value.expression.argument.type === 'CallExpression' &&
      path.value.expression.argument.callee.property.name === 'then'
    ))
    .replaceWith((path) => {
      return [
        j.variableDeclaration(
          'let',
          [
            j.variableDeclarator(
              j.identifier(path.value.expression.argument.arguments[0].params[0].name),
              j.awaitExpression(path.value.expression.argument.callee.object)
            )
          ]
        ),
        ...path.value.expression.argument.arguments[0].body.body
      ]
    })

  return root.toSource();
}