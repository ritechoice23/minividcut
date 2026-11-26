// App-drawn scrollbars. The system scrollbars are hidden everywhere (see
// style.css) and replaced by slim rounded thumbs that float over the edge of
// whatever area is being scrolled or hovered. They fade out when idle, can be
// dragged, and look the same on every Windows and WebView2 version.
// Elements marked data-scrollbar="always" (the timeline scroller) keep their
// thumb visible all the time because the bar is their only control.

type Axis = 'y' | 'x'
type Thumbs = { y: HTMLDivElement; x: HTMLDivElement; hideTimer: number }

const IDLE_MS = 900
const MIN_THUMB = 28
const EDGE = 2

const scrollable = (element: Element, axis: Axis) => {
  const style = getComputedStyle(element)
  const overflow = axis === 'y' ? style.overflowY : style.overflowX
  if (overflow !== 'auto' && overflow !== 'scroll') return false
  return axis === 'y'
    ? element.scrollHeight > element.clientHeight + 1
    : element.scrollWidth > element.clientWidth + 1
}

function scrollerAt(node: EventTarget | null): HTMLElement | null {
  let element = node instanceof Element ? node : null
  while (element && element !== document.body) {
    if (element instanceof HTMLElement && !element.classList.contains('slim-thumb')
      && (scrollable(element, 'y') || scrollable(element, 'x'))) return element
    element = element.parentElement
  }
  return null
}

export function installSlimScrollbars() {
  if (typeof window === 'undefined' || document.documentElement.dataset.slimScrollbars) return
  document.documentElement.dataset.slimScrollbars = 'on'
  const thumbs = new Map<HTMLElement, Thumbs>()
  let hovered: HTMLElement | null = null
  let dragging: { element: HTMLElement; axis: Axis; pointer: number; scroll: number } | null = null

  const pinned = (element: HTMLElement) => element.dataset.scrollbar === 'always'

  const thumbsFor = (element: HTMLElement) => {
    let entry = thumbs.get(element)
    if (entry) return entry
    const make = (axis: Axis) => {
      const thumb = document.createElement('div')
      thumb.className = `slim-thumb slim-thumb-${axis}`
      thumb.setAttribute('aria-hidden', 'true')
      thumb.addEventListener('pointerdown', event => {
        event.preventDefault()
        event.stopPropagation()
        thumb.setPointerCapture(event.pointerId)
        dragging = {
          element, axis,
          pointer: axis === 'y' ? event.clientY : event.clientX,
          scroll: axis === 'y' ? element.scrollTop : element.scrollLeft,
        }
        thumb.classList.add('dragging')
      })
      thumb.addEventListener('pointermove', event => {
        if (!dragging || dragging.element !== element || dragging.axis !== axis) return
        const rect = element.getBoundingClientRect()
        const track = axis === 'y' ? rect.height : rect.width
        const size = axis === 'y' ? thumb.offsetHeight : thumb.offsetWidth
        const range = axis === 'y' ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth
        const moved = (axis === 'y' ? event.clientY : event.clientX) - dragging.pointer
        const next = dragging.scroll + moved * range / Math.max(1, track - size)
        if (axis === 'y') element.scrollTop = next
        else element.scrollLeft = next
      })
      const stop = () => {
        dragging = null
        thumb.classList.remove('dragging')
        reveal(element)
      }
      thumb.addEventListener('pointerup', stop)
      thumb.addEventListener('lostpointercapture', stop)
      thumb.addEventListener('pointerenter', () => reveal(element, true))
      thumb.addEventListener('pointerleave', () => reveal(element))
      document.body.append(thumb)
      return thumb
    }
    entry = { y: make('y'), x: make('x'), hideTimer: 0 }
    thumbs.set(element, entry)
    return entry
  }

  const place = (element: HTMLElement, entry: Thumbs) => {
    if (!element.isConnected) {
      entry.y.remove()
      entry.x.remove()
      thumbs.delete(element)
      return
    }
    const rect = element.getBoundingClientRect()
    for (const axis of ['y', 'x'] as const) {
      const thumb = entry[axis]
      if (!scrollable(element, axis) || rect.width < 8 || rect.height < 8) {
        thumb.style.display = 'none'
        continue
      }
      thumb.style.display = 'block'
      if (axis === 'y') {
        const size = Math.max(MIN_THUMB, rect.height * element.clientHeight / element.scrollHeight)
        const range = element.scrollHeight - element.clientHeight
        const offset = (rect.height - size) * (element.scrollTop / Math.max(1, range))
        thumb.style.height = `${size - EDGE * 2}px`
        thumb.style.transform = `translate(${rect.right - 7}px, ${rect.top + offset + EDGE}px)`
      } else {
        const size = Math.max(MIN_THUMB, rect.width * element.clientWidth / element.scrollWidth)
        const range = element.scrollWidth - element.clientWidth
        const offset = (rect.width - size) * (element.scrollLeft / Math.max(1, range))
        thumb.style.width = `${size - EDGE * 2}px`
        thumb.style.transform = `translate(${rect.left + offset + EDGE}px, ${rect.bottom - 7}px)`
      }
    }
  }

  function reveal(element: HTMLElement, hold = false) {
    const entry = thumbsFor(element)
    place(element, entry)
    entry.y.classList.add('visible')
    entry.x.classList.add('visible')
    window.clearTimeout(entry.hideTimer)
    if (hold || pinned(element) || dragging?.element === element) return
    entry.hideTimer = window.setTimeout(() => {
      if (hovered === element && element.matches(':hover')) return
      entry.y.classList.remove('visible')
      entry.x.classList.remove('visible')
    }, IDLE_MS)
  }

  // Keep every visible thumb attached to its area as things move or resize.
  let frame = 0
  const sync = () => {
    frame = 0
    for (const [element, entry] of thumbs) {
      if (pinned(element) || entry.y.classList.contains('visible') || entry.x.classList.contains('visible')) {
        place(element, entry)
      }
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(sync) }

  document.addEventListener('scroll', event => {
    const element = event.target instanceof HTMLElement ? event.target : null
    if (element && !element.classList.contains('slim-thumb')) reveal(element)
    schedule()
  }, { capture: true, passive: true })

  document.addEventListener('pointermove', event => {
    if (dragging) return
    const element = scrollerAt(event.target)
    if (element === hovered) return
    const previous = hovered
    hovered = element
    if (element) reveal(element)
    if (previous && thumbs.has(previous)) reveal(previous)
  }, { passive: true })

  window.addEventListener('resize', schedule)

  // Pinned scrollers (the timeline bar) appear and change size with the
  // layout, so watch for them and keep their thumb in place.
  const resize = new ResizeObserver(schedule)
  const watchPinned = () => {
    for (const element of document.querySelectorAll<HTMLElement>('[data-scrollbar="always"]')) {
      if (!thumbs.has(element)) {
        resize.observe(element)
        reveal(element)
      }
    }
    schedule()
  }
  let pinFrame = 0
  new MutationObserver(() => {
    if (!pinFrame) pinFrame = requestAnimationFrame(() => { pinFrame = 0; watchPinned() })
  }).observe(document.body, { childList: true, subtree: true })
  watchPinned()
}
