import * as browser from 'webextension-polyfill'

import { FAILED_MESSAGE, STATUS_MESSAGE, SUCCESS_MESSAGE } from './const.js'
import providers from './providers.js'
import sources from './sources.js'
import TabRunner from './tabrunner.js'
import { ArticleInfo, Message, Provider, SiteSourceParams, Source } from './types.js'
import { interpolate } from './utils.js'

enum PHASE {
  LOGIN = 'login',
  SEARCH = 'search',
}

class SourceBot {
  step: number
  phase: PHASE
  sourceId: string
  providerId: string
  provider: Provider
  source: Source
  sourceParams: SiteSourceParams
  articleInfo: ArticleInfo
  providerOptions: object
  userData: object
  callback: (message: Message) => void
  tabId: number
  tabRunner: TabRunner
  done: boolean

  constructor (sourceId, providerId, providerOptions, sourceParams, articleInfo, callback) {
    this.step = 0
    this.phase = PHASE.LOGIN

    this.providerId = providerId
    this.provider = providers[providerId]

    this.sourceId = this.provider.defaultSource || sourceId
    this.source = sources[this.sourceId]

    this.sourceParams = sourceParams
    this.articleInfo = articleInfo
    this.providerOptions = providerOptions
    this.callback = callback
    this.userData = Object.assign({
      bibName: this.provider.bibName || this.provider.name
    }, this.providerOptions);
    ['options.username', 'options.password'].forEach(key => {
      const confValue = this.userData[`${this.providerId}.${key}`]
      if (confValue !== undefined) {
        this.userData[key] = confValue
      }
    })

    this.onTabUpdated = this.onTabUpdated.bind(this)
    this.done = false
  }

  getParams () {
    return Object.assign(
      {},
      this.source.defaultParams || {},
      this.provider.params[this.sourceId],
      this.sourceParams
    )
  }

  async run () {
    const url = this.makeUrl(this.provider.start || this.source.start)
    const tab = await browser.tabs.create({
      url,
      active: false
    })
    this.tabId = tab.id
    console.log('tab created', tab.id)
    this.tabRunner = new TabRunner(tab.id, this.userData)
    browser.tabs.onUpdated.addListener(this.onTabUpdated)
  }

  cleanUp () {
    browser.alarms.clear(`tab${this.tabId}`)
    browser.tabs.onUpdated.removeListener(this.onTabUpdated)
  }

  onTabUpdated (tabId, changeInfo) {
    if (this.done) {
      this.cleanUp()
      return
    }
    if (tabId !== this.tabId) {
      return
    }
    if (changeInfo.status === 'complete') {
      console.log('tab load complete', tabId)
      this.runNextSourceStep()
    }
  }

  async runNextSourceStep () {
    const loggedIn = await this.isLoggedIn()
    if (loggedIn) {
      this.step = 0
      this.phase = PHASE.SEARCH
    }
    await this.runActionsOfCurrentStep()
  }

  async isLoggedIn () {
    if (this.phase === PHASE.LOGIN && this.step === 0) {
      const result = await browser.scripting.executeScript({
        target: {
          tabId: this.tabId
        },
        func: (selector) => document.querySelector(selector) !== null,
        args: [this.source.loggedIn]
      })
      console.log('loggedin?', result[0].result)
      return result[0].result
    }
    return false
  }

  getActionList () {
    return this.provider[this.phase] || this.source[this.phase]
  }

  getActions () {
    const actionList = this.getActionList()
    const actions = actionList[this.step]
    if (Array.isArray(actions)) {
      return actions
    }
    throw new Error('Unknown action in source')
  }

  isFinalStep () {
    return (
      this.phase === PHASE.SEARCH &&
      this.step === this.source[this.phase].length - 1
    )
  }

  handleAction (action) {
    if (action.message) {
      // message does not need to run through tabrunner
      this.callback({
        type: STATUS_MESSAGE,
        message: action.message
      })
      return null
    }
    if (action.url) {
      // recreate action.url with interpolated url
      action = Object.assign({}, action)
      action.url = this.makeUrl(action.url)
    }
    return action
  }

  async runActionsOfCurrentStep () {
    const actions = this.getActions()

    let result
    let skipWait = false
    for (let action of actions) {
      action = this.handleAction(action)
      if (action === null) { continue }
      try {
        result = await this.tabRunner.runAction(action)
      } catch (e) {
        this.fail(e.toString())
        return
      }
      if (typeof result === 'function') {
        if (!result(this)) {
          this.cleanUp()
          return
        }
      }
      if (action.skipToNext && result === true) {
        skipWait = true
        break
      }
    }
    const isFinalStep = this.isFinalStep()
    if (isFinalStep) {
      this.finalize(result)
      return
    }
    // Move to next step and wait for tab update event
    this.step += 1
    const actionList = this.getActionList()
    if (this.step > actionList.length - 1) {
      if (this.phase === PHASE.LOGIN) {
        this.phase = PHASE.SEARCH
      }
      this.step = 0
    }
    if (skipWait) {
      await this.runNextSourceStep()
    }
  }

  finalize (result: string) {
    this.done = true
    if (result.length > 0) {
      this.callback({
        type: SUCCESS_MESSAGE,
        content: result
      })

      browser.tabs.remove(this.tabId)
      this.cleanUp()
    } else {
      this.fail('failed to find content')
    }
  }

  fail (message) {
    console.error(message)
    this.callback({
      type: FAILED_MESSAGE,
      message
    })
    this.cleanUp()
  }

  makeUrl (url) {
    if (typeof url === 'function') {
      return url(this.articleInfo, this.getParams())
    }
    url = interpolate(url, this.articleInfo, '', encodeURIComponent)
    const params = this.getParams()
    url = interpolate(url, params, 'source', encodeURIComponent)
    return url
  }

  activateTab () {
    browser.tabs.update(this.tabId, {
      active: true
    })
  }
}

export default SourceBot
