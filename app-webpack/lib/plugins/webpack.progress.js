const { ProgressPlugin } = require('webpack')
const throttle = require('lodash/throttle.js')
const { green, gray, bold, trueColor } = require('kolorist')

const { success, info, error, warning, clearConsole, dot } = require('../utils/logger.js')
const { isMinimalTerminal } = require('../utils/is-minimal-terminal.js')
const { printWebpackWarnings, printWebpackErrors } = require('../utils/print-webpack-issue/index.js')
const { progressLog } = require('../utils/progress-log.js')

let maxLengthName = 0
let isDev = false

const compilations = []

function isCompilationIdle () {
  return compilations.every(entry => entry.idle === true)
}

function createState (name) {
  const state = {
    name,
    idle: true,
    compiled: false,
    warnings: null,
    errors: null,
    startTime: null,
    progress: null,
    progressMessage: '',
    progressDetails: ''
  }

  const len = name.length
  if (len > maxLengthName) {
    maxLengthName = len
  }

  compilations.push(state)
  return state
}

/**
 * Progress bar related
 */

const barLength = 20
const barProgressFactor = barLength / 100
const barString = Array.apply(null, { length: barLength })
  .map((_, index) => {
    const p = index / barLength
    const colorize = p <= 0.5
      ? trueColor(255, Math.round(p * 510), 0)
      : trueColor(255 - Math.round(p * 122), 255, 0)

    return colorize('█')
  })

function printBars () {
  if (progressLog.isActive !== true) {
    return
  }

  const prefixLen = compilations.length - 1

  const lines = compilations.map((state, index) => {
    const prefix = index < prefixLen ? '├──' : '└──'

    const name = green(state.name.padEnd(maxLengthName))

    const barWidth = Math.floor(state.progress * barProgressFactor)
    const bar = barString
      .map((char, index) => (index <= barWidth ? char : ' '))
      .join('')

    const details = state.idle === false
      ? state.progress + '% ' + ([
        state.progressMessage,
        state.progressDetails ? [ state.progressDetails[ 0 ], state.progressDetails[ 1 ] ].filter(s => s).join(' ') : ''
      ].filter(m => m).join(' '))
      : 'idle'

    return ` ${ prefix } ${ name } ${ bar } ${ gray(details) }\n`
  })

  progressLog(`\n ${ dot } ${ green(bold('Compiling with Webpack')) }:\n` + lines.join(''))
}

const renderBars = throttle(printBars, 200)

/**
 * Status related
 */

function printStatus () {
  if (isDev === true && isCompilationIdle() === false) {
    return
  }

  const entriesWithErrors = compilations.filter(entry => entry.errors !== null)
  if (entriesWithErrors.length > 0) {
    isDev === true && clearConsole()

    entriesWithErrors.forEach(entry => { printWebpackErrors(entry.name, entry.errors) })
    console.log()
    error('Please check the log above for details.\n', 'COMPILATION FAILED')

    if (isDev === false) {
      process.exit(1)
    }

    return
  }

  if (isDev !== true && isCompilationIdle() === false) {
    return
  }

  const entriesWithWarnings = compilations.filter(entry => entry.warnings !== null)
  if (entriesWithWarnings.length > 0) {
    entriesWithWarnings.forEach(entry => { printWebpackWarnings(entry.name, entry.warnings) })
    console.log()
    warning('Compilation succeeded but there are warning(s). Please check the log above.\n')
  }
}

module.exports.WebpackProgressPlugin = class WebpackProgressPlugin extends ProgressPlugin {
  constructor ({ name, quasarConf }) {
    const useBars = isMinimalTerminal !== true && quasarConf.build.webpackShowProgress === true

    if (useBars === true) {
      super({
        handler: (percent, msg, ...details) => {
          this.updateBars(percent, msg, details)
        }
      })
    }
    else {
      super({ handler: () => {} })
    }

    this.opts = {
      quasarConf,
      name,
      useBars
    }

    isDev = quasarConf.ctx.dev === true
  }

  apply (compiler) {
    if (this.opts.useBars) {
      super.apply(compiler)
    }

    compiler.hooks.watchClose.tap('QuasarProgressPlugin', () => {
      const index = compilations.indexOf(this.state)
      compilations.splice(index, 1)

      delete this.state

      if (this.opts.useBars === true) {
        if (compilations.length === 0) {
          // ensure progress log is stopped!
          progressLog.stop()
        }

        maxLengthName = compilations.reduce(
          (acc, entry) => (entry.name.length > acc ? entry.name.length : acc),
          0
        )
      }
    })

    compiler.hooks.compile.tap('QuasarProgressPlugin', () => {
      if (this.state === void 0) {
        this.state = createState(this.opts.name)
      }
      else {
        this.resetStats()
      }

      this.state.idle = false

      info(`Compiling of "${ this.state.name }" by Webpack in progress...`, 'WAIT')

      if (this.opts.useBars === true) {
        progressLog.start()
      }

      this.state.startTime = +new Date()
    })

    compiler.hooks.done.tap('QuasarStatusPlugin', stats => {
      this.state.idle = true
      this.resetStats()

      if (stats.hasErrors()) {
        this.state.errors = stats
      }
      else {
        this.state.compiled = true
        if (stats.hasWarnings()) {
          this.state.warnings = stats
        }
      }

      if (this.opts.useBars === true && isCompilationIdle() === true) {
        progressLog.stop()
      }

      const diffTime = +new Date() - this.state.startTime

      if (this.state.errors !== null) {
        error(`"${ this.state.name }" compiled by Webpack with errors ${ dot } ${ diffTime }ms`, 'DONE')
      }
      else if (this.state.warnings !== null) {
        warning(`"${ this.state.name }" compiled by Webpack, but with warnings ${ dot } ${ diffTime }ms`, 'DONE')
      }
      else {
        success(`"${ this.state.name }" compiled with success by Webpack ${ dot } ${ diffTime }ms`, 'DONE')
      }

      printStatus()
    })
  }

  resetStats () {
    this.state.errors = null
    this.state.warnings = null
  }

  updateBars (percent, msg, details) {
    // it may still be called even after compilation was closed
    // due to Webpack's delayed call of handler
    if (this.state === void 0) { return }

    const progress = Math.floor(percent * 100)
    const running = progress < 100

    this.state.progress = progress
    this.state.progressMessage = running && msg ? msg : ''
    this.state.progressDetails = details

    this.opts.useBars === true && renderBars()
  }
}
