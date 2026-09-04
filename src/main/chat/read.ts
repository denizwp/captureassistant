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

/*
 * Chat is a list of rows. Each row can mix colours — a name in one colour and
 * what they said in another — so the text is collected character by character
 * along with the colour actually being used to paint it, and neighbouring
 * characters of the same colour are then folded back into one run.
 *
 * Whitespace is collapsed on the way through. The game pads rows for layout,
 * and keeping that padding would make every archived line ragged.
 */
export const READ_CHAT = `JSON.stringify((function () {
  var rows = document.querySelectorAll('.chat-messages > *, .chat__messages > li, #chat-messages > *');
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
  for (var i = 0; i < rows.length; i++) {
    var line = readRow(rows[i]);
    if (line.t) out.push(line);
  }
  return out;
})())`

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
