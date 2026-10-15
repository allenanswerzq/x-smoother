void function() {

const responseTextCache = new WeakMap()
const xhrUrls = new WeakMap()

function isEnabled() {
  return localStorage.cpftEnabled != 'false' &&
    localStorage.cpftSortForYouByRecency != 'false'
}

function isForYouTimeline(url) {
  try {
    return new URL(url, location.origin).pathname.endsWith('/HomeTimeline')
  } catch {
    return false
  }
}

function getPostId(entry) {
  if (typeof entry?.entryId != 'string') return null
  return entry.entryId.match(/^(?:tweet|home-conversation|conversationthread)-(\d{15,})$/)?.[1] ?? null
}

function rewriteTimeline(payload) {
  let instructions = payload?.data?.home?.home_timeline_urt?.instructions
  if (!Array.isArray(instructions)) return 0

  let changed = 0
  for (let instruction of instructions) {
    let entries = Array.isArray(instruction?.entries)
      ? instruction.entries
      : instruction?.entry ? [instruction.entry] : []

    for (let entry of entries) {
      let postId = getPostId(entry)
      if (postId == null || entry.sortIndex == null || String(entry.sortIndex) == postId) continue
      entry.sortIndex = postId
      changed++
    }
  }
  return changed
}

function rewriteText(response, text) {
  let cached = responseTextCache.get(response)
  if (cached?.original == text) return cached.rewritten

  let rewritten = text
  try {
    let payload = JSON.parse(text)
    if (rewriteTimeline(payload) > 0) rewritten = JSON.stringify(payload)
  } catch {}

  responseTextCache.set(response, {original: text, rewritten})
  return rewritten
}

const responseJson = Response.prototype.json
Response.prototype.json = async function() {
  let payload = await responseJson.call(this)
  if (isEnabled() && isForYouTimeline(this.url)) rewriteTimeline(payload)
  return payload
}

const responseText = Response.prototype.text
Response.prototype.text = async function() {
  let text = await responseText.call(this)
  return isEnabled() && isForYouTimeline(this.url) ? rewriteText(this, text) : text
}

const xhrOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function(method, url, ...args) {
  xhrUrls.set(this, String(url))
  return xhrOpen.apply(this, [method, url, ...args])
}

for (let property of ['response', 'responseText']) {
  let descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, property)
  if (descriptor?.get == null || descriptor.configurable === false) continue

  Object.defineProperty(XMLHttpRequest.prototype, property, {
    ...descriptor,
    get() {
      let value = descriptor.get.call(this)
      if (!isEnabled() || this.readyState != XMLHttpRequest.DONE || !isForYouTimeline(xhrUrls.get(this))) {
        return value
      }
      if (typeof value == 'string') return rewriteText(this, value)
      if (value != null && typeof value == 'object') rewriteTimeline(value)
      return value
    },
  })
}

}()
