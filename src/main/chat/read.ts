/*
 * The expressions that run inside the game's interface.
 *
 * They only read: they walk the chat element that is already on screen and
 * report what it says and what colour each part of it is. Nothing is clicked,
 * typed, or changed.
 */

export interface RawRun {
  s: number
  n: number
  c: string
}

export interface RawLine {
  t: string
  r: RawRun[]
}

export interface ChatLocation {
  path: string
  rows: number
  sample: string
}

/*
 * Finding the chat without being told where it is.
 *
 * Servers replace the stock chat with their own, so matching on a class name
 * only works until someone reskins it. Instead every element is scored on how
 * much it looks like a chat log from the outside: a stack of children that each
 * carry their own line of text, most of them opening with a clock. Whatever
 * scores highest wins, and a path to it is handed back so the reading that
 * follows costs one lookup instead of another sweep.
 */
export const FIND_CHAT = `JSON.stringify((function () {
  function pathTo(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var parent = el.parentElement;
      if (!parent) break;
      var index = 1;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i] === el) break;
        if (parent.children[i].tagName === el.tagName) index++;
      }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
      el = parent;
    }
    return parts.length ? parts.join(' > ') : 'body';
  }

  var best = null;
  var bestScore = 0;
  var all = document.getElementsByTagName('*');

  for (var i = 0; i < all.length; i++) {
    var node = all[i];
    var kids = node.children;
    if (kids.length < 2 || kids.length > 400) continue;

    var withText = 0;
    var stamped = 0;
    for (var k = 0; k < kids.length; k++) {
      var text = (kids[k].innerText || '').trim();
      if (!text || text.length > 600) continue;
      withText++;
      if (/^[\\[(]?\\d{1,2}:\\d{2}/.test(text)) stamped++;
    }
    if (withText < 2) continue;

    /*
     * A clock on most children is the strongest sign, since a menu or an
     * inventory list never has one. The name is only a nudge on top, for the
     * servers that did keep something recognisable.
     */
    var score = withText + stamped * 4;
    var name = ((typeof node.className === 'string' ? node.className : '') + ' ' + (node.id || '')).toLowerCase();
    if (name.indexOf('chat') >= 0 || name.indexOf('message') >= 0) score += 25;
    if (score > bestScore) { bestScore = score; best = node; }
  }

  if (!best) return null;
  var first = '';
  for (var j = 0; j < best.children.length; j++) {
    var t = (best.children[j].innerText || '').trim();
    if (t) { first = t; break; }
  }
  return { path: pathTo(best), rows: best.children.length, sample: first.slice(0, 120) };
})())`

/*
 * Chat is a list of rows. Each row can mix colours — a name in one colour and
 * what they said in another — so the text is collected character by character
 * along with the colour actually being used to paint it, and neighbouring
 * characters of the same colour are then folded back into one run.
 *
 * Whitespace is collapsed on the way through. The game pads rows for layout,
 * and keeping that padding would make every archived line ragged.
 */
export function readChat(path: string): string {
  return `JSON.stringify((function () {
  var host = document.querySelector(${JSON.stringify(path)});
  if (!host) return null;
  function hex(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return '#ffffff';
    var parts = (getComputedStyle(el).color || '').match(/[\\d.]+/g);
    if (!parts || parts.length < 3) return '#ffffff';
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.max(0, Math.min(255, Math.round(Number(parts[i]))));
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }
  function readRow(row) {
    var text = '';
    var runs = [];
    var gap = false;
    function put(ch, color) {
      var last = runs.length ? runs[runs.length - 1] : null;
      if (last && last.c === color && last.s + last.n === text.length) last.n += ch.length;
      else runs.push({ s: text.length, n: ch.length, c: color });
      text += ch;
    }
    function walk(node) {
      if (node.nodeType === 3) {
        var value = node.nodeValue || '';
        var color = hex(node);
        for (var i = 0; i < value.length; i++) {
          var ch = value.charAt(i);
          if (/\\s/.test(ch)) { if (text.length) gap = true; continue; }
          if (gap) { put(' ', color); gap = false; }
          put(ch, color);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = (node.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      var style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (tag === 'BR') { if (text.length) gap = true; return; }
      for (var k = 0; k < node.childNodes.length; k++) walk(node.childNodes[k]);
    }
    walk(row);
    /*
     * If walking the tree produced something other than what the row plainly
     * reads as, the colours cannot be trusted to line up with the characters.
     * The text still gets archived; only the colouring is given up.
     */
    var plain = (row.innerText || '').replace(/\\s+/g, ' ').trim();
    if (text !== plain) return { t: plain, r: [] };
    return { t: text, r: runs };
  }
  var out = [];
  for (var i = 0; i < host.children.length; i++) {
    var line = readRow(host.children[i]);
    if (line.t) out.push(line);
  }
  return out;
})())`
}

/*
 * Which server this is. The loading screen leaves its handover data on the
 * window, and that is the only place a friendly name is reliably available;
 * the address alone is the fallback so logs still separate per server.
 */
export const READ_SERVER = `JSON.stringify((function () {
  var h = (typeof window === 'object' && window && typeof window.nuiHandoverData === 'object')
    ? window.nuiHandoverData : {};
  var address = (typeof h.serverAddress === 'string' && h.serverAddress)
    || (typeof serverAddress === 'string' ? serverAddress : '');
  var name = h.serverName || h.projectName || h.hostname || '';
  return { address: address || '', name: String(name || '') };
})())`

export interface ServerHint {
  address: string
  name: string
}

/*
 * The handover data only exists while the loading screen does, so by the time
 * anyone opens this the friendly name is usually gone and all that is left is
 * an address. Every Cfx server answers with its own details on the port it is
 * running on, which is where the name comes from once play has started.
 */
export async function resolveServerName(address: string): Promise<string | null> {
  const info = (await fetch(`http://${address}/info.json`, {
    signal: AbortSignal.timeout(2500)
  })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)) as { vars?: Record<string, unknown> } | null

  const vars = info?.vars ?? {}
  for (const key of ['sv_projectName', 'sv_hostname', 'serverName']) {
    const value = vars[key]
    if (typeof value === 'string' && value.trim()) return clean(value)
  }
  return null
}

/*
 * Server names are written for the in-game list, which paints them from ^1-style
 * colour codes and strips its own markup. Left in, they end up in file names.
 */
function clean(name: string): string {
  return name
    .replace(/\^\d/g, '')
    .replace(/~[a-z]~/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
