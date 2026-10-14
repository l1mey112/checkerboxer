// Shared by the browser renderer and server so only real Markdown tasks toggle.
export function collectTasks(tokens, markdown) {
  const lines = markdown.split('\n');
  const tasks = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'list_item_open' || tokens[i + 1]?.type !== 'paragraph_open') continue;
    const inline = tokens[i + 2];
    if (inline?.type !== 'inline' || !/^\[[ xX]\](?:\s|$)/.test(inline.content)) continue;
    const line = inline.map?.[0];
    const match = lines[line]?.match(/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[([ xX])\](?=[ \t\r]|$)/);
    if (!match) continue;
    tasks.push({ line, checked: match[1].toLowerCase() === 'x', marker: match[0].length - 2, inline, item: tokens[i] });
  }
  return tasks;
}
