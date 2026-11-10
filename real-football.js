/* ============================================================================
 *  real-football.js — المباريات الحقيقية داخل نظام الرهان (Tawaqqo Arena)
 *  ضعه بجانب server.js (نفس المجلد). لا يحتاج أي حزمة خارجية.
 *  فيه: خريطة الدوريات · أسماء الفرق بالعربية · تحويل مباراة API-Sports إلى مباراة ساحة
 *       · نموذج احتمالات المباراة الحية (بواسون) لتسعير الرهان أثناء اللعب.
 *
 *  تعديل: لم يعد الملف يحصر المباريات في الدوريات المعروفة. أي دوري/كأس في العالم يُقبل:
 *   - الدوريات الموجودة في LEAGUE_MAP تحتفظ بمعرّفاتها القديمة (epl, laliga ...)
 *   - أي دوري آخر يأخذ المعرّف w<رقم الدوري> ويحمل اسمه وشعاره ودولته داخل المباراة
 *     (leagueName / leagueLogo / country / leagueFlag) لتعرضها الواجهة.
 * ============================================================================ */

/* معرّف الدوري في API-Sports ← معرّف الدوري في التطبيق (data.js) */
export const LEAGUE_MAP = {
  39: "epl", 140: "laliga", 135: "seriea", 78: "bundes", 2: "ucl", 307: "spl", 233: "egy", 17: "afc",
};

/* حالات API-Sports */
const UPCOMING = new Set(["TBD", "NS", "PST"]);
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);
const ENDED = new Set(["FT", "AET", "PEN"]);
const VOID = new Set(["CANC", "ABD", "AWD", "WO"]);

/* أسماء الفرق بالعربية (الاسم كما يأتي من API-Sports بالإنجليزية) */
const AR = {
  /* الدوري الإنجليزي وما حوله */
  "Arsenal": "آرسنال", "Aston Villa": "أستون فيلا", "Bournemouth": "بورنموث", "Brentford": "برينتفورد",
  "Brighton": "برايتون", "Burnley": "بيرنلي", "Chelsea": "تشيلسي", "Crystal Palace": "كريستال بالاس",
  "Everton": "إيفرتون", "Fulham": "فولهام", "Leeds": "ليدز يونايتد", "Liverpool": "ليفربول",
  "Manchester City": "مانشستر سيتي", "Manchester United": "مانشستر يونايتد", "Newcastle": "نيوكاسل",
  "Nottingham Forest": "نوتينغهام فورست", "Sunderland": "سندرلاند", "Tottenham": "توتنهام",
  "West Ham": "وست هام", "Wolves": "وولفرهامبتون", "Hull City": "هل سيتي", "Leicester": "ليستر سيتي",
  "Ipswich": "إيبسويتش", "Southampton": "ساوثهامبتون", "Coventry": "كوفنتري", "Middlesbrough": "ميدلزبره",
  "Sheffield Utd": "شيفيلد يونايتد", "Sheffield United": "شيفيلد يونايتد", "Millwall": "ميلوول",
  "Watford": "واتفورد", "Norwich": "نورويتش", "West Brom": "وست بروميتش",
  /* الدوري الإسباني وما حوله */
  "Real Madrid": "ريال مدريد", "Barcelona": "برشلونة", "Atletico Madrid": "أتلتيكو مدريد",
  "Athletic Club": "أتلتيك بلباو", "Real Sociedad": "ريال سوسيداد", "Villarreal": "فياريال",
  "Real Betis": "ريال بيتيس", "Sevilla": "إشبيلية", "Valencia": "فالنسيا", "Girona": "جيرونا",
  "Celta Vigo": "سيلتا فيغو", "Osasuna": "أوساسونا", "Getafe": "خيتافي", "Rayo Vallecano": "رايو فاليكانو",
  "Mallorca": "ريال مايوركا", "Alaves": "ألافيس", "Espanyol": "إسبانيول", "Levante": "ليفانتي",
  "Elche": "إلتشي", "Real Oviedo": "ريال أوفييدو", "Oviedo": "ريال أوفييدو", "Las Palmas": "لاس بالماس",
  "Leganes": "ليغانيس", "Valladolid": "بلد الوليد", "Malaga": "ملقا", "Racing Santander": "راسينغ سانتاندير",
  "Deportivo La Coruna": "ديبورتيفو لا كورونيا", "Almeria": "ألميريا",
  "Cadiz": "قادش", "Granada": "غرناطة", "Eibar": "إيبار", "Castellon": "كاستيون", "Sporting Gijon": "سبورتينغ خيخون",
  "Zaragoza": "سرقسطة", "Burgos": "بورغوس", "Cordoba": "قرطبة", "Huesca": "هويسكا",
  /* إيطاليا / ألمانيا / أخرى شائعة */
  "Juventus": "يوفنتوس", "AC Milan": "ميلان", "Inter": "إنتر ميلان", "Napoli": "نابولي", "AS Roma": "روما",
  "Lazio": "لاتسيو", "Atalanta": "أتالانتا", "Fiorentina": "فيورنتينا",
  "Bayern Munich": "بايرن ميونخ", "Borussia Dortmund": "بوروسيا دورتموند", "Bayer Leverkusen": "باير ليفركوزن",
  "RB Leipzig": "لايبزيغ", "Paris Saint Germain": "باريس سان جيرمان", "Al Hilal": "الهلال", "Al Nassr": "النصر",
  "Al Ahly": "الأهلي", "Zamalek": "الزمالك", "Pyramids": "بيراميدز",
};
export const arName = (n) => AR[n] || n;

const shortOf = (n) => String(n || "???").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "FC";
function colorsOf(n) {                       // لونان ثابتان من اسم الفريق (يظهران إن تعذّر الشعار)
  let h = 0;
  for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue} 70% 46%)`, `hsl(${(hue + 24) % 360} 72% 26%)`];
}
const teamOf = (t) => ({ id: t?.id, name: arName(t?.name), nameEn: t?.name, short: shortOf(t?.name), colors: colorsOf(t?.name), logo: t?.logo || null });

/* ---- تحويل مباراة API-Sports إلى حقول مباراة الساحة (كل دوريات وكؤوس العالم) ---- */
export function parseFixture(it) {
  const f = it?.fixture, lg = it?.league;
  if (!f?.id || !lg?.id || !it.teams?.home || !it.teams?.away) return null;
  const leagueId = LEAGUE_MAP[lg.id] || `w${lg.id}`;   // دوري غير معروف ← w<رقم> بدل رفض المباراة
  const short = f.status?.short || "NS";
  const goals = [Number(it.goals?.home) || 0, Number(it.goals?.away) || 0];
  const ft = it.score?.fulltime;
  const hasFt = ft && ft.home != null && ft.away != null;
  const status = VOID.has(short) ? "void" : ENDED.has(short) ? "ended" : LIVE.has(short) ? "live" : UPCOMING.has(short) ? "upcoming" : "upcoming";
  let minute = short === "HT" ? 45 : Math.min(120, Number(f.status?.elapsed) || 0);
  if (status === "live" && minute < 1) minute = 1;
  if (status === "ended") minute = 90;
  return {
    id: `r${f.id}`, fid: f.id, real: true, leagueId, leagueApiId: lg.id, apiStatus: short, status,
    leagueName: lg.name || "", leagueLogo: lg.logo || "", country: lg.country || "", leagueFlag: lg.flag || "",
    startsAt: (Number(f.timestamp) || 0) * 1000, minute,
    score: status === "ended" && hasFt ? [ft.home, ft.away] : goals,   // التسوية تعتمد نتيجة الـ90 دقيقة
    round: lg.round || "", home: teamOf(it.teams.home), away: teamOf(it.teams.away),
  };
}

/* ---- نموذج المباراة الحية (بواسون) ---- */
const fact = (n) => (n <= 1 ? 1 : n * fact(n - 1));
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact(k);
export const OPT = 17;

/** توزيع النتيجة النهائية بعد 90 دقيقة بالنظر للنتيجة والدقيقة الحاليتين */
export function liveDist(score, minute) {
  const left = Math.max(0, (90 - Math.min(90, minute))) / 90;
  const lh = 1.45 * left, la = 1.15 * left;
  const exact = Array(OPT).fill(0), res = [0, 0, 0];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const p = pois(i, lh) * pois(j, la);
    const h = score[0] + i, a = score[1] + j;
    exact[h <= 3 && a <= 3 ? h * 4 + a : OPT - 1] += p;
    res[h > a ? 0 : h === a ? 1 : 2] += p;
  }
  const norm = (arr) => { const s = arr.reduce((x, y) => x + y, 0) || 1; return arr.map((v) => v / s); };
  return { exact: norm(exact), res: norm(res) };
}

/** الخيارات المستحيلة (النتيجة الحالية تجاوزتها) في سوق النتيجة الدقيقة */
export const deadExact = (score) =>
  Array.from({ length: OPT }, (_, i) => (i === OPT - 1 ? false : Math.floor(i / 4) < score[0] || i % 4 < score[1]));

/** مجمّعات فعّالة للتسعير: قبل الانطلاق = أموال اللاعبين كما هي، أثناء اللعب = مزج بالنموذج (وزن النموذج يكبر مع الدقيقة) */
export function effPools(pools, model, minute, live) {
  if (!live) return pools;
  const tot = pools.reduce((a, b) => a + b, 0) || 1;
  const w = Math.min(0.95, 0.3 + 0.65 * (Math.min(90, minute) / 90));
  const raw = pools.map((p, i) => Math.pow(Math.max(p, 1e-6) / tot, 1 - w) * Math.pow(Math.max(model[i], 1e-6), w));
  const s = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((v) => +((v / s) * tot).toFixed(4));
}
