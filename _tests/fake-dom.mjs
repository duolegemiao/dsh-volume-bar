/**
 * A deliberately small DOM double for _tests/client.test.mjs.
 *
 * It supports only what the browser half uses: element/class/attribute queries,
 * `closest`, `matches`, `isConnected`, style custom properties, dataset and a
 * microtask-driven MutationObserver. Enough to run the real bundle, and small
 * enough to reason about.
 */

function matchesSimple(element, selector) {
  const tokens = selector.match(/^[a-z]+|\[[^\]]+\]|\.[A-Za-z0-9_-]+|:[a-z-]+/gi) ?? []
  for (const token of tokens) {
    if (token.startsWith('.')) {
      if (!element.classList.contains(token.slice(1))) return false
    } else if (token.startsWith('#')) {
      if (element.id !== token.slice(1)) return false
    } else if (token.startsWith('[')) {
      const body = token.slice(1, -1)
      const equals = body.match(/^([A-Za-z0-9_-]+)(?:([*^$~|]?=)"?([^"\]]*)"?)?$/)
      if (!equals) return false
      const [, name, operator, wanted] = equals
      const value = element.getAttribute(name)
      if (value === null) return false
      if (operator === undefined) continue
      if (operator === '=' && value !== wanted) return false
      if (operator === '*=' && !value.includes(wanted)) return false
      if (operator === '^=' && !value.startsWith(wanted)) return false
      if (operator === '$=' && !value.endsWith(wanted)) return false
    } else if (token.startsWith(':')) {
      if (token === ':hover') {
        if (!element.hovered) return false
      } else if (token === ':focus-visible') {
        if (!element.focused) return false
      } else {
        return false
      }
    } else if (element.tagName !== token.toUpperCase()) {
      return false
    }
  }
  return true
}

function matchesSelector(element, selector) {
  return selector.split(',').some((part) => matchesSimple(element, part.trim()))
}

export class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.childNodes = []
    this.parentElement = null
    this.attributes = new Map()
    this.dataset = {}
    this.style = {
      values: new Map(),
      setProperty: (name, value) => {
        this.style.values.set(name, String(value))
      },
      removeProperty: (name) => {
        this.style.values.delete(name)
      },
      getPropertyValue: (name) => this.style.values.get(name) ?? '',
    }
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (name) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean))
        names.add(name)
        this.className = Array.from(names).join(' ')
      },
      remove: (name) => {
        this.className = this.className.split(/\s+/).filter((item) => item && item !== name).join(' ')
      },
      toggle: (name, force) => {
        const has = this.classList.contains(name)
        const next = force === undefined ? !has : force
        if (next) this.classList.add(name)
        else this.classList.remove(name)
      },
    }
    this.hovered = false
    this.focused = false
    this.isConnected = true
    this.listeners = new Map()
  }

  get className() {
    return this.attributes.get('class') ?? ''
  }

  set className(value) {
    this.attributes.set('class', String(value))
  }

  get id() {
    return this.attributes.get('id') ?? ''
  }

  set id(value) {
    this.attributes.set('id', String(value))
  }

  get children() {
    return this.childNodes
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent ?? '').join('')
  }

  set textContent(value) {
    this.childNodes = []
    this._text = String(value)
  }

  getAttribute(name) {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      if (this.dataset[key] !== undefined) return String(this.dataset[key])
    }
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'class') return
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  matches(selector) {
    return matchesSelector(this, selector)
  }

  closest(selector) {
    let node = this
    while (node) {
      if (node.matches && node.matches(selector)) return node
      node = node.parentElement
    }
    return null
  }

  appendChild(child) {
    child.parentElement = this
    this.childNodes.push(child)
    return child
  }

  remove() {
    if (!this.parentElement) return
    this.parentElement.childNodes = this.parentElement.childNodes.filter((item) => item !== this)
    this.parentElement = null
    this.isConnected = false
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.matches(selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  addEventListener(type, listener, options) {
    const list = this.listeners.get(type) ?? []
    list.push({ listener, options })
    this.listeners.set(type, list)
  }

  removeEventListener(type, listener, options) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter((entry) => entry.listener !== listener || entry.options !== options))
  }

  dispatch(type, event = {}) {
    for (const { listener } of this.listeners.get(type) ?? []) listener({ type, target: this, ...event })
  }
}

export class FakeDocument {
  constructor() {
    this.head = new FakeElement('head', this)
    this.body = new FakeElement('body', this)
    this.childNodes = [this.head, this.body]
    this.listeners = new Map()
    this.visibilityState = 'visible'
    this.observers = []
  }

  createElement(tagName) {
    return new FakeElement(tagName, this)
  }

  getElementById(id) {
    return this.body.querySelector(`#${id}`) ?? this.head.querySelector(`#${id}`)
  }

  querySelector(selector) {
    for (const node of this.childNodes) {
      if (node.matches(selector)) return node
      const found = node.querySelector(selector)
      if (found) return found
    }
    return null
  }

  querySelectorAll(selector) {
    const found = []
    for (const node of this.childNodes) {
      if (node.matches(selector)) found.push(node)
      for (const child of node.querySelectorAll(selector)) found.push(child)
    }
    return found
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener))
  }

  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this, ...event })
  }
}

export class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = []
    FakeMutationObserver.instances.push(this)
  }

  observe(target, options) {
    this.targets.push({ target, options })
  }

  disconnect() {
    this.targets = []
  }

  /** Deliver a pending mutation to every live observer (microtask semantics). */
  static flush() {
    for (const observer of FakeMutationObserver.instances) {
      if (observer.targets.length) observer.callback([], observer)
    }
  }
}

FakeMutationObserver.instances = []

/** Build the DSH rail markup: slot > nav[aria-label] > scroller > marks > ticks. */
export function buildRail(document, count, { activeIndex = count - 1, markClasses = 'xpvNua_mark' } = {}) {
  const slot = document.createElement('div')
  slot.className = 'xpvNua_slot'
  const nav = document.createElement('nav')
  nav.className = 'xpvNua_frame'
  nav.setAttribute('aria-label', '对话轮次导航')
  const scroller = document.createElement('div')
  scroller.className = 'xpvNua_scroller'
  const marks = document.createElement('div')
  marks.className = 'xpvNua_marks'
  const ticks = []
  for (let i = 0; i < count; i++) {
    const tick = document.createElement('button')
    tick.dataset.index = String(i)
    tick.className = i === activeIndex ? `${markClasses} xpvNua_markActive` : markClasses
    if (i === activeIndex) tick.setAttribute('aria-current', 'true')
    marks.appendChild(tick)
    ticks.push(tick)
  }
  scroller.appendChild(marks)
  nav.appendChild(scroller)
  slot.appendChild(nav)
  return { slot, nav, scroller, marks, ticks }
}
