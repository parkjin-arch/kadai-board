// 日本の祝日（「国民の祝日に関する法律」のルールから計算する。2000年以降に対応）
// 内閣府の祝日CSVと同じ結果になるように、振替休日・国民の休日・2019〜2021年の特例も含めている。
// 外部ファイルを読まないのでオフラインでも動き、将来の年も表示できる。
// ※ 法改正で祝日が変わった場合は、このファイルのルールを直す。

const cache = new Map();
const key = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** その月の第 n 月曜日 */
function nthMonday(y, m, n) {
  const first = new Date(y, m - 1, 1).getDay();
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

/** 春分日・秋分日（1980〜2099年の近似式。国立天文台の暦象年表と一致する） */
function equinox(y, base) {
  return Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

/** その年の祝日 Map<"YYYY-MM-DD", 名前> */
export function holidaysOf(y) {
  if (cache.has(y)) return cache.get(y);
  const h = new Map();
  const add = (m, d, name) => h.set(key(y, m, d), name);

  add(1, 1, '元日');
  add(1, nthMonday(y, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (y >= 2020) add(2, 23, '天皇誕生日');
  else if (y <= 2018) add(12, 23, '天皇誕生日');
  add(3, equinox(y, 20.8431), '春分の日');
  add(4, 29, '昭和の日'); // 2006年以前は「みどりの日」だが表示名のみの違い
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');

  // 東京五輪の特例（2020・2021年）
  if (y === 2020) {
    add(7, 23, '海の日'); add(7, 24, 'スポーツの日'); add(8, 10, '山の日');
  } else if (y === 2021) {
    add(7, 22, '海の日'); add(7, 23, 'スポーツの日'); add(8, 8, '山の日');
  } else {
    add(7, nthMonday(y, 7, 3), '海の日');
    if (y >= 2016) add(8, 11, '山の日');
    add(10, nthMonday(y, 10, 2), y >= 2020 ? 'スポーツの日' : '体育の日');
  }
  add(9, nthMonday(y, 9, 3), '敬老の日');
  add(9, equinox(y, 23.2488), '秋分の日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');

  // 天皇の即位に伴う特例（2019年）
  if (y === 2019) {
    add(5, 1, '休日（祝日扱い）');
    add(10, 22, '休日（祝日扱い）');
  }

  // 国民の休日：祝日に挟まれた平日（例：2026年 9/22）
  for (const k of [...h.keys()]) {
    const [yy, mm, dd] = k.split('-').map(Number);
    const d = new Date(yy, mm - 1, dd);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const after = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2);
    const nk = key(next.getFullYear(), next.getMonth() + 1, next.getDate());
    const ak = key(after.getFullYear(), after.getMonth() + 1, after.getDate());
    if (!h.has(nk) && h.has(ak) && next.getDay() !== 0) h.set(nk, '休日');
  }

  // 振替休日：祝日が日曜なら、その後の最初の祝日でない日
  for (const k of [...h.keys()].sort()) {
    const [yy, mm, dd] = k.split('-').map(Number);
    if (new Date(yy, mm - 1, dd).getDay() !== 0) continue;
    let d = new Date(yy, mm - 1, dd + 1);
    while (h.has(key(d.getFullYear(), d.getMonth() + 1, d.getDate()))) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    h.set(key(d.getFullYear(), d.getMonth() + 1, d.getDate()), '振替休日');
  }

  const sorted = new Map([...h.entries()].sort());
  cache.set(y, sorted);
  return sorted;
}

/** その日の祝日名（祝日でなければ null） */
export function holidayName(date) {
  return holidaysOf(date.getFullYear()).get(key(date.getFullYear(), date.getMonth() + 1, date.getDate())) || null;
}
