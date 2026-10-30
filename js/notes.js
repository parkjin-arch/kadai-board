// 今週のノート：テキストの解釈（箇条書き・チェック）
//
// 書き方
//   - 牛乳を買う        … チェックできる項目（未チェック）
//   - [x] 牛乳を買う    … チェック済み
//   それ以外の行        … ふつうの文章（改行はそのまま）
//
// 保存の形: { id: '2026-10-26'（その週の月曜）, text, carryDecided, updatedAt }

const ITEM = /^(\s*)[-・]\s+(\[( |x|X)\]\s+)?(.*)$/;

/** 1行を解釈する */
export function parseLine(line) {
  const m = line.match(ITEM);
  if (!m) return { type: 'text', text: line };
  return { type: 'item', indent: m[1].length, checked: !!m[3] && m[3] !== ' ', text: m[4] };
}

/** i 行目のチェックを切り替えたテキストを返す */
export function toggleLine(text, i) {
  const lines = text.split('\n');
  const p = parseLine(lines[i] || '');
  if (p.type !== 'item') return text;
  lines[i] = `${' '.repeat(p.indent)}- [${p.checked ? ' ' : 'x'}] ${p.text}`;
  return lines.join('\n');
}

/** 未チェックの項目だけを "- 〇〇" の形で取り出す（引き継ぎ用） */
export function uncheckedItems(text) {
  return (text || '')
    .split('\n')
    .map(parseLine)
    .filter((p) => p.type === 'item' && !p.checked && p.text.trim())
    .map((p) => `${' '.repeat(p.indent)}- ${p.text}`);
}
