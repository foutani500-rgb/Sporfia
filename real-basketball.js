/* ============================================================================
 *  real-basketball.js — محرّك كرة السلة (ساحة التوقّع)
 *  ----------------------------------------------------------------------------
 *  ملف مستقل بلا اعتماديات: يستورده server.js بجانب real-football.js
 *   - قراءة مباريات API-Basketball (v1.basketball.api-sports.io) وترتيب الدوريات
 *   - قوة الفريق (0..1) من نسبة الفوز + آخر النتائج + فارق النقاط + الترتيب
 *   - النسب التلقائية: نسبة الربح ٪ بين الحد الأدنى (0.4) والأعلى (15)
 *        فريق قوي ونتائجه جيدة  → احتمال فوزه مرتفع → نسبة قليلة
 *        فريق ضعيف              → احتمال فوزه منخفض → نسبة مرتفعة
 *   - الأسواق الاحترافية: الفائز، الفارق، المجموع، نقاط كل فريق، زوجي/فردي،
 *     الشوط الأول، الربع الأول، شوط/نهاية، الربع الأعلى تسجيلاً، فارق الفوز، الوقت الإضافي
 *   - تسوية الرهانات من النتيجة النهائية وأرباع المباراة
 *   - محاكاة مباريات تجريبية (نفس فكرة محاكاة كرة القدم)
 * ========================================================================== */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/* ---------- رياضيات ---------- */
/** دالة التوزيع الطبيعي التراكمي (تقريب Abramowitz-Stegun) */
export function nCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const hash01 = (seed) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
};
const snap = (x) => Math.floor(x) + 0.5;
const pOver = (mean, sd, line) => 1 - nCdf((line - mean) / sd);

/* ---------- حدود النسبة (٪) ---------- */
export function bbBounds(S = {}) {
  const lo = clamp(num(S.bbRateMin) ?? 0.4, 0, 50);
  const hi = Math.max(lo, clamp(num(S.bbRateMax) ?? 15, 0.1, 100));
  return { lo, hi };
}

/* ---------- أسماء عربية وألوان ---------- */
const AR = {
  "Atlanta Hawks": "أتلانتا هوكس", "Boston Celtics": "بوسطن سلتكس", "Brooklyn Nets": "بروكلين نتس", "Charlotte Hornets": "شارلوت هورنتس",
  "Chicago Bulls": "شيكاغو بولز", "Cleveland Cavaliers": "كليفلاند كافاليرز", "Dallas Mavericks": "دالاس مافريكس", "Denver Nuggets": "دنفر ناغتس",
  "Detroit Pistons": "ديترويت بيستونز", "Golden State Warriors": "غولدن ستيت ووريرز", "Houston Rockets": "هيوستن روكتس", "Indiana Pacers": "إنديانا بيسرز",
  "Los Angeles Clippers": "لوس أنجلوس كليبرز", "LA Clippers": "لوس أنجلوس كليبرز", "Los Angeles Lakers": "لوس أنجلوس ليكرز", "Memphis Grizzlies": "ممفيس غريزليز",
  "Miami Heat": "ميامي هيت", "Milwaukee Bucks": "ميلووكي باكس", "Minnesota Timberwolves": "مينيسوتا تيمبروولفز", "New Orleans Pelicans": "نيو أورلينز بيليكانز",
  "New York Knicks": "نيويورك نيكس", "Oklahoma City Thunder": "أوكلاهوما ثاندر", "Orlando Magic": "أورلاندو ماجيك", "Philadelphia 76ers": "فيلادلفيا سيفنتي سيكسرز",
  "Phoenix Suns": "فينيكس صنز", "Portland Trail Blazers": "بورتلاند بلايزرز", "Sacramento Kings": "ساكرامنتو كينغز", "San Antonio Spurs": "سان أنطونيو سبيرز",
  "Toronto Raptors": "تورنتو رابتورز", "Utah Jazz": "يوتا جاز", "Washington Wizards": "واشنطن ويزاردز",
  "Real Madrid": "ريال مدريد", "FC Barcelona": "برشلونة", "Barcelona": "برشلونة", "Olympiacos": "أولمبياكوس", "Panathinaikos": "باناثينايكوس",
  "Fenerbahce": "فنربخشة", "Anadolu Efes": "أناضولو إفيس", "Partizan": "بارتيزان", "AS Monaco": "موناكو", "Bayern Munich": "بايرن ميونخ",
  "Crvena Zvezda": "النجم الأحمر", "Baskonia": "باسكونيا", "Valencia": "فالنسيا", "Virtus Bologna": "فيرتوس بولونيا", "Zalgiris": "زالغيريس",
};
export const arName = (en) => AR[en] || en;
export function colorsFor(name) {
  const h = Math.floor(hash01(String(name)) * 360);
  return [`hsl(${h} 70% 48%)`, `hsl(${(h + 28) % 360} 70% 26%)`];
}
export function shortOf(en) {
  const w = String(en || "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return String(en || "").slice(0, 3);
  if (w.length === 1) return w[0].slice(0, 3).toUpperCase();
  let s = w.slice(0, 3).map((x) => x[0]).join("");
  if (s.length < 3) s += w[0].slice(1, 3 - s.length + 1);
  return s.toUpperCase().slice(0, 3);
}
const teamObj = (t) => ({
  name: arName(t?.name || "—"), nameEn: t?.name || "", short: shortOf(t?.name), colors: colorsFor(t?.name), logo: t?.logo || "", apiId: t?.id ?? null,
});

/* ---------- قراءة مباراة من API-Basketball ---------- */
const LIVE_ST = new Set(["Q1", "Q2", "Q3", "Q4", "OT", "BT", "HT"]);
const END_ST = new Set(["FT", "AOT"]);
const VOID_ST = new Set(["CANC", "POST", "ABD", "AWD"]);
export const lenOf = (leagueName) => (/NBA/i.test(String(leagueName || "")) ? 48 : 40);

export function parseGame(it) {
  if (!it || it.id == null || !it.teams?.home || !it.teams?.away) return null;
  const st = String(it.status?.short || "NS").toUpperCase();
  const side = (k) => {
    const s = it.scores?.[k] || {};
    return { q: [s.quarter_1, s.quarter_2, s.quarter_3, s.quarter_4, s.over_time].map(num), total: num(s.total) };
  };
  const H = side("home"), A = side("away");
  const len = lenOf(it.league?.name), qL = len / 4;
  const sum = (a) => a.q.reduce((x, y) => x + (y ?? 0), 0);
  const score = [H.total ?? sum(H), A.total ?? sum(A)];
  const done = H.q.slice(0, 4).filter((v) => v !== null).length;
  let status = "upcoming", period = 0, brk = false;
  if (END_ST.has(st)) status = "ended";
  else if (VOID_ST.has(st)) status = "void";
  else if (LIVE_ST.has(st) || st === "SUSP") {
    status = "live";
    if (st === "OT") period = 5;
    else if (st === "BT") { period = clamp(done, 1, 3); brk = true; }
    else if (st === "HT") { period = 2; brk = true; }
    else if (/^Q[1-4]$/.test(st)) period = Number(st[1]);
    else period = clamp(done, 1, 4);
  }
  const otPts = (H.q[4] ?? 0) + (A.q[4] ?? 0);
  return {
    id: `bk${it.id}`, real: true, fid: it.id,
    leagueApiId: it.league?.id ?? null, leagueId: `bb${it.league?.id ?? 0}`, leagueName: it.league?.name || "كرة السلة", leagueLogo: it.league?.logo || "", country: it.country?.name || "",
    startsAt: (num(it.timestamp) ?? Math.floor(Date.parse(it.date) / 1000)) * 1000,
    status, apiStatus: st, period, brk, score, len,
    q: { h: H.q, a: A.q }, ot: status === "ended" ? otPts > 0 || st === "AOT" : period >= 5,
    home: teamObj(it.teams.home), away: teamObj(it.teams.away),
    _qL: qL,
  };
}

/* ---------- الترتيب → سجل الفريق ---------- */
export function parseStandings(json) {
  const out = {};
  const flat = [];
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") flat.push(x); };
  walk(json?.response);
  const byLeague = {};
  for (const r of flat) {
    const id = r?.team?.id;
    if (id == null) continue;
    const gp = num(r.games?.played) ?? 0;
    const w = num(r.games?.win?.total);
    let wp = num(r.games?.win?.percentage);
    if (wp !== null && wp > 1) wp /= 100;
    if (wp === null && gp > 0 && w !== null) wp = w / gp;
    const rec = {
      name: r.team?.name || "", gp, win: w, winPct: wp, pf: num(r.points?.for), pa: num(r.points?.against),
      form: String(r.form || ""), pos: num(r.position), league: r.league?.id ?? null,
    };
    out[id] = rec;
    (byLeague[`${rec.league}:${r.group?.name || ""}`] ||= []).push(rec);
  }
  for (const list of Object.values(byLeague)) for (const rec of list) rec.rankPct = rec.pos && list.length > 1 ? (rec.pos - 1) / (list.length - 1) : null;
  return out;
}

const formScore = (form) => {
  const ch = String(form || "").toUpperCase().replace(/[^WLD]/g, "").slice(-8);
  if (!ch) return null;
  let a = 0, b = 0;
  [...ch].forEach((c, i) => { const w = i + 1; a += w * (c === "W" ? 1 : c === "D" ? 0.5 : 0); b += w; });
  return a / b;
};
/** قوة الفريق 0..1 (0.5 = متوسط الدوري) — تجمع نسبة الفوز وآخر النتائج وفارق النقاط والترتيب */
export function teamStrength(rec, len = 48) {
  if (!rec) return null;
  const parts = [];
  if (rec.winPct !== null && rec.winPct !== undefined) parts.push([0.45, clamp(rec.winPct, 0, 1)]);
  const f = formScore(rec.form);
  if (f !== null) parts.push([0.25, f]);
  if (rec.gp > 0 && rec.pf !== null && rec.pa !== null) parts.push([0.2, clamp(0.5 + (rec.pf - rec.pa) / rec.gp / (len >= 48 ? 24 : 18), 0, 1)]);
  if (rec.rankPct !== null && rec.rankPct !== undefined) parts.push([0.1, 1 - clamp(rec.rankPct, 0, 1)]);
  if (!parts.length) return null;
  const wsum = parts.reduce((a, [w]) => a + w, 0);
  const raw = parts.reduce((a, [w, v]) => a + w * v, 0) / wsum;
  const trust = 0.4 + 0.6 * clamp((rec.gp || 0) / 20, 0, 1);   // مباريات قليلة → اقترب من المتوسط
  return +clamp(0.5 + (raw - 0.5) * trust, 0.03, 0.97).toFixed(3);
}
export const tierOf = (s) => (s >= 0.66 ? "قوي" : s >= 0.45 ? "متوسط" : "ضعيف");

/* ---------- النموذج الاحتمالي ---------- */
const strengthOf = (m, side) => {
  const ov = num(m.sOv?.[side === "home" ? "h" : "a"]);
  if (ov !== null) return clamp(ov, 0.02, 0.98);
  return clamp(num(m[side]?.strength) ?? 0.5, 0.02, 0.98);
};
export function modelOf(m) {
  const L = m.len || 48, live = m.status === "live";
  const sH = strengthOf(m, "home"), sA = strengthOf(m, "away");
  const k = L >= 48 ? 22 : 15, hca = L >= 48 ? 2.6 : 3.2;
  const mm0 = (sH - sA) * k + hca + (num(m.edge) ?? 0);
  const base = num(m.base) ?? (L >= 48 ? 114 : 81);
  const tt0 = num(m.totalBase) > 0 ? num(m.totalBase) : 2 * base * (1 + (sH + sA - 1) * 0.03);
  const sdM = 11.5 * Math.sqrt(L / 48), sdT = 17 * Math.sqrt(L / 48);
  const e = live ? Math.max(0, num(m.minute) ?? 0) : 0;
  const ot = live && ((m.period || 0) >= 5 || e > L);
  const rem = !live ? L : ot ? Math.max(0.5, L + 5 - e) : Math.max(0, L - e);
  const f = rem / L;
  const cH = live ? m.score?.[0] ?? 0 : 0, cA = live ? m.score?.[1] ?? 0 : 0;
  return {
    L, qL: L / 4, e, live, ot, f, sH, sA, mm0, tt0, sdM, sdT, cH, cA,
    mM: cH - cA + mm0 * f, sM: Math.max(0.6, sdM * Math.sqrt(f)),
    tM: cH + cA + tt0 * f, sT: Math.max(0.8, sdT * Math.sqrt(f)),
    hM: cH + ((tt0 + mm0) / 2) * f, aM: cA + ((tt0 - mm0) / 2) * f, sTm: Math.max(0.6, Math.sqrt(((sdT * sdT + sdM * sdM) / 4) * f)),
    otH: clamp(0.52 + (sH - sA) * 0.12, 0.35, 0.65),
  };
}
const spanMod = (mod, span) => {
  const fr = Math.max(0, span - mod.e) / mod.L;
  return { mean: mod.cH - mod.cA + mod.mm0 * fr, sd: Math.max(0.6, mod.sdM * Math.sqrt(fr)) };
};
const HW = 0.85;
const HQ = [0.235, 0.255, 0.245, 0.265];
const WM = { "1-5": [0.5, 5.5], "6-10": [5.5, 10.5], "11-15": [10.5, 15.5], "16-20": [15.5, 20.5], "21+": [20.5, 999] };
const parseLine = (s) => { const x = Number(s); return Number.isFinite(x) && Math.abs(x * 2) % 2 === 1 && Math.abs(x) < 400 ? x : null; };

/** احتمال خيار واحد (null = خيار غير صالح) */
export function probOf(m, mod, key, id) {
  const [a, b] = String(id).split(":");
  switch (key) {
    case "ml": {
      const pT = nCdf((HW - mod.mM) / mod.sM) - nCdf((-HW - mod.mM) / mod.sM);
      const pH = 1 - nCdf((HW - mod.mM) / mod.sM) + pT * mod.otH;
      return id === "h" ? pH : id === "a" ? 1 - pH : null;
    }
    case "sp": {
      const line = parseLine(b); if (line === null || Math.abs(line) > 60) return null;
      if (a === "h") return pOver(mod.mM, mod.sM, -line);
      if (a === "a") return nCdf((line - mod.mM) / mod.sM);
      return null;
    }
    case "tot": {
      const line = parseLine(b); if (line === null || line < 20) return null;
      const p = pOver(mod.tM, mod.sT, line);
      return a === "o" ? p : a === "u" ? 1 - p : null;
    }
    case "tth": case "tta": {
      const line = parseLine(b); if (line === null || line < 10) return null;
      const p = pOver(key === "tth" ? mod.hM : mod.aM, mod.sTm, line);
      return a === "o" ? p : a === "u" ? 1 - p : null;
    }
    case "wm": {
      const r = WM[b]; if (!r || (a !== "h" && a !== "a")) return null;
      const mean = a === "h" ? mod.mM : -mod.mM;
      return clamp(nCdf((r[1] - mean) / mod.sM) - nCdf((r[0] - mean) / mod.sM), 0, 1);
    }
    case "eo": return id === "odd" || id === "even" ? 0.5 : null;
    case "ot": {
      const p = nCdf((HW - mod.mM) / mod.sM) - nCdf((-HW - mod.mM) / mod.sM);
      return id === "yes" ? p : id === "no" ? 1 - p : null;
    }
    case "h1": case "q1": {
      const h = spanMod(mod, key === "h1" ? mod.L / 2 : mod.qL);
      const pH = 1 - nCdf((0.5 - h.mean) / h.sd), pA = nCdf((-0.5 - h.mean) / h.sd);
      if (id === "h") return pH / (pH + pA); if (id === "a") return pA / (pH + pA);
      return null;
    }
    case "htft": {
      if (!["hh", "ha", "ah", "aa"].includes(id)) return null;
      const h = spanMod(mod, mod.L / 2), mean2 = mod.mm0 * 0.5, sd2 = mod.sdM * Math.sqrt(0.5);
      const acc = { hh: 0, ha: 0, ah: 0, aa: 0 };
      for (let i = 0; i < 61; i++) {
        const z = -4 + (8 * i) / 60, w = Math.exp((-z * z) / 2), M1 = h.mean + z * h.sd;
        if (Math.abs(M1) < 0.5) continue;
        const f = M1 > 0 ? "h" : "a", pF = nCdf((M1 + mean2) / sd2);
        acc[f + "h"] += w * pF; acc[f + "a"] += w * (1 - pF);
      }
      const tot = acc.hh + acc.ha + acc.ah + acc.aa || 1;
      return acc[id] / tot;
    }
    case "hq": {
      const i = Number(id) - 1; if (!(i >= 0 && i < 4)) return null;
      return HQ[i] / HQ.reduce((x, y) => x + y, 0);
    }
    default: return null;
  }
}

/* ---------- تعريف الأسواق ---------- */
export const MARKET_META = {
  ml: { title: "الفائز بالمباراة", desc: "يشمل الوقت الإضافي", tab: "main" },
  sp: { title: "الفارق (هانديكاب)", desc: "الفريق يفوز بعد إضافة/خصم الفارق", tab: "main" },
  tot: { title: "إجمالي النقاط", desc: "مجموع نقاط الفريقين (يشمل الإضافي)", tab: "main" },
  tth: { title: "نقاط المستضيف", desc: "أكثر/أقل من خط نقاط المستضيف", tab: "teams" },
  tta: { title: "نقاط الضيف", desc: "أكثر/أقل من خط نقاط الضيف", tab: "teams" },
  eo: { title: "مجموع النقاط زوجي/فردي", desc: "المجموع النهائي للنقاط", tab: "teams" },
  h1: { title: "الفائز بالشوط الأول", desc: "التعادل في الشوط = استرداد", tab: "halves" },
  q1: { title: "الفائز بالربع الأول", desc: "التعادل في الربع = استرداد", tab: "halves" },
  htft: { title: "الشوط الأول / نهاية المباراة", desc: "توقّع فائز الشوط وفائز المباراة معاً", tab: "halves" },
  hq: { title: "الربع الأعلى تسجيلاً", desc: "أي ربع يشهد أكبر عدد نقاط (الأوقات القانونية)", tab: "halves" },
  wm: { title: "فارق الفوز", desc: "فارق النقاط النهائي بين الفريقين", tab: "pro" },
  ot: { title: "هل تذهب للوقت الإضافي؟", desc: "تعادل بعد الأرباع الأربعة", tab: "pro" },
};
export const MARKET_ORDER = ["ml", "sp", "tot", "tth", "tta", "eo", "h1", "q1", "htft", "hq", "wm", "ot"];

/** هل السوق مفتوح الآن؟ (الحي: كل سوق له وقت إغلاق) */
export function marketOpen(m, mod, key, S = {}) {
  if (m.status === "ended" || m.status === "void") return false;
  if (m.status !== "live") return true;
  const cut = clamp(num(S.bbLiveCutoffMin) ?? 4, 0, 20), L = mod.L;
  if (mod.ot) return false;
  switch (key) {
    case "h1": case "htft": return mod.e < L / 2 - 2;
    case "q1": return mod.e < mod.qL * 0.3;
    case "hq": return mod.e < 2;
    case "ot": return mod.e < L - 10;
    default: return mod.e < L - cut;
  }
}
const fl = (x) => (x > 0 ? `+${x}` : `${x}`);
export function labelOf(m, key, id) {
  const hn = m.home?.name || "المستضيف", an = m.away?.name || "الضيف";
  const [a, b] = String(id).split(":");
  switch (key) {
    case "ml": return id === "h" ? `فوز ${hn}` : `فوز ${an}`;
    case "sp": return `${a === "h" ? hn : an} (${fl(Number(b))})`;
    case "tot": return `${a === "o" ? "أكثر من" : "أقل من"} ${b}`;
    case "tth": return `${hn}: ${a === "o" ? "أكثر من" : "أقل من"} ${b}`;
    case "tta": return `${an}: ${a === "o" ? "أكثر من" : "أقل من"} ${b}`;
    case "eo": return id === "odd" ? "فردي" : "زوجي";
    case "h1": return `${id === "h" ? hn : an} يفوز بالشوط الأول`;
    case "q1": return `${id === "h" ? hn : an} يفوز بالربع الأول`;
    case "htft": return `${id[0] === "h" ? hn : an} ← ${id[1] === "h" ? hn : an}`;
    case "hq": return `الربع ${id}`;
    case "wm": return `${a === "h" ? hn : an} بفارق ${b}`;
    case "ot": return id === "yes" ? "نعم — وقت إضافي" : "لا — ينتهي في 4 أرباع";
    default: return String(id);
  }
}
const tabLabel = { main: "الرئيسية", teams: "الفرق والنقاط", halves: "الأشواط والأرباع", pro: "متقدّمة" };
export { tabLabel };

/** نسبة الربح ٪ من الاحتمال — قوي (احتمال مرتفع) = نسبة قليلة، ضعيف = نسبة مرتفعة */
export function rateFromP(p, S = {}, jitterSeed = null) {
  const { lo, hi } = bbBounds(S);
  if (S.bbAutoRates === false) return +((lo + hi) / 2).toFixed(2);
  let q = clamp(p, 0, 1);
  if (jitterSeed) {
    const noise = clamp(num(S.bbNoisePct) ?? 2, 0, 15) / 100;
    q = clamp(q * (1 + (hash01(`${jitterSeed}:${Math.floor(Date.now() / 10000)}`) - 0.5) * 2 * noise), 0, 1);
  }
  return +(lo + (hi - lo) * (1 - q)).toFixed(2);
}
const manualRate = (m, key, id, S) => {
  const v = num(m.manualRates?.[key]?.[id]);
  if (v === null) return null;
  const { lo, hi } = bbBounds(S);
  return +clamp(v, lo, hi).toFixed(2);
};
/** سعر خيار واحد لحظة الرهان */
export function priceOption(m, S, key, id) {
  if (!MARKET_META[key]) return null;
  const mod = modelOf(m), p = probOf(m, mod, key, id);
  if (p === null) return null;
  const live = m.status === "live";
  const open = marketOpen(m, mod, key, S);
  const locked = !open || (live && (p >= 0.96 || p <= 0.004));
  return { key, id, label: labelOf(m, key, id), p, open, locked, rate: manualRate(m, key, id, S) ?? rateFromP(p, S, `${m.id}:${key}:${id}`) };
}

/** كل أسواق المباراة بخياراتها ونسبها */
export function buildMarkets(m, S = {}) {
  const mod = modelOf(m);
  const hn = m.home?.name || "المستضيف", an = m.away?.name || "الضيف";
  const mk = (key, list, extra = {}) => {
    const open = marketOpen(m, mod, key, S);
    const options = list.map(([id, side, line]) => {
      const p = probOf(m, mod, key, id);
      if (p === null) return null;
      const locked = !open || (m.status === "live" && (p >= 0.96 || p <= 0.004));
      return { id, side, line: line ?? null, label: labelOf(m, key, id), p: +p.toFixed(4), rate: manualRate(m, key, id, S) ?? rateFromP(p, S, `${m.id}:${key}:${id}`), locked };
    }).filter(Boolean);
    const meta = MARKET_META[key];
    return { key, title: key === "tth" ? `نقاط ${hn}` : key === "tta" ? `نقاط ${an}` : meta.title, desc: meta.desc, tab: meta.tab, open, options, ...extra };
  };
  const spMain = -snap(mod.mM), tMain = snap(mod.tM), hMain = snap(mod.hM), aMain = snap(mod.aM);
  const sp = [-4, 0, 4].flatMap((d) => { const l = spMain + d; return [[`h:${l}`, "h", l], [`a:${-l}`, "a", -l]]; });
  const tot = [-6, 0, 6].flatMap((d) => { const l = tMain + d; return [[`o:${l}`, "o", l], [`u:${l}`, "u", l]]; });
  const tt = (c) => [-3, 0, 3].flatMap((d) => { const l = c + d; return [[`o:${l}`, "o", l], [`u:${l}`, "u", l]]; });
  const wm = ["h", "a"].flatMap((s) => Object.keys(WM).map((r) => [`${s}:${r}`, s]));
  const out = [
    mk("ml", [["h", "h"], ["a", "a"]]),
    mk("sp", sp, { mainLine: spMain }),
    mk("tot", tot, { mainLine: tMain }),
    mk("tth", tt(hMain), { mainLine: hMain }),
    mk("tta", tt(aMain), { mainLine: aMain }),
    mk("eo", [["odd", "odd"], ["even", "even"]]),
    mk("h1", [["h", "h"], ["a", "a"]]),
    mk("q1", [["h", "h"], ["a", "a"]]),
    mk("htft", [["hh", "hh"], ["ha", "ha"], ["ah", "ah"], ["aa", "aa"]]),
    mk("hq", [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]]),
    mk("wm", wm),
    mk("ot", [["yes", "yes"], ["no", "no"]]),
  ];
  return out.filter((x) => x.options.length && (x.open || m.status !== "live" || ["ml", "sp", "tot"].includes(x.key)));
}

/* ---------- التسوية ---------- */
const sumQ = (arr, n) => { const x = (arr || []).slice(0, n); return x.length === n && x.every((v) => Number.isFinite(Number(v)) && v !== null) ? x.reduce((a, b) => a + Number(b), 0) : null; };
/** نتيجة رهان بعد انتهاء المباراة: "won" | "lost" | "push" (استرداد) */
export function outcomeOf(m, b) {
  const H = m.score?.[0] ?? 0, A = m.score?.[1] ?? 0;
  const key = b.market, id = String(b.pick);
  const [a, c] = id.split(":");
  const win = (x) => (x ? "won" : "lost");
  const qh = m.q?.h, qa = m.q?.a;
  switch (key) {
    case "ml": return win(id === "h" ? H > A : A > H);
    case "sp": { const line = Number(c), d = a === "h" ? H + line - A : A + line - H; return d === 0 ? "push" : win(d > 0); }
    case "tot": { const line = Number(c), t = H + A; return t === line ? "push" : win(a === "o" ? t > line : t < line); }
    case "tth": case "tta": { const line = Number(c), t = key === "tth" ? H : A; return t === line ? "push" : win(a === "o" ? t > line : t < line); }
    case "eo": return win((H + A) % 2 === (id === "odd" ? 1 : 0));
    case "ot": return win(id === "yes" ? !!m.ot : !m.ot);
    case "wm": { const d = a === "h" ? H - A : A - H, r = WM[c]; return r && d > r[0] && d < r[1] ? "won" : "lost"; }
    case "h1": { const h = sumQ(qh, 2), x = sumQ(qa, 2); if (h === null || x === null || h === x) return "push"; return win(id === "h" ? h > x : x > h); }
    case "q1": { const h = num(qh?.[0]), x = num(qa?.[0]); if (h === null || x === null || h === x) return "push"; return win(id === "h" ? h > x : x > h); }
    case "htft": {
      const h = sumQ(qh, 2), x = sumQ(qa, 2); if (h === null || x === null || h === x) return "push";
      const first = h > x ? "h" : "a", fin = H > A ? "h" : "a";
      return win(id === first + fin);
    }
    case "hq": {
      const t = [0, 1, 2, 3].map((i) => (num(qh?.[i]) === null || num(qa?.[i]) === null ? null : qh[i] + qa[i]));
      if (t.some((v) => v === null)) return "push";
      const mx = Math.max(...t), win4 = t.map((v, i) => (v === mx ? i + 1 : 0)).filter(Boolean);
      if (win4.length > 1 && win4.includes(Number(id))) return "push";
      return win(win4[0] === Number(id));
    }
    default: return "push";
  }
}

/* ---------- محاكاة المباريات التجريبية ---------- */
const T = (en, s) => ({ name: arName(en), nameEn: en, short: shortOf(en), colors: colorsFor(en), logo: "", strength: s });
const NBA = { id: "bb-nba", name: "NBA", country: "أمريكا" }, EUR = { id: "bb-euro", name: "اليوروليغ", country: "أوروبا" };
export const BB_FIXTURES = [
  { lg: NBA, home: T("Boston Celtics", 0.84), away: T("Los Angeles Lakers", 0.6), inMinutes: -22, hot: true },
  { lg: NBA, home: T("Oklahoma City Thunder", 0.82), away: T("Washington Wizards", 0.17), inMinutes: -9 },
  { lg: NBA, home: T("Denver Nuggets", 0.76), away: T("Golden State Warriors", 0.58), inMinutes: 25, hot: true },
  { lg: NBA, home: T("Milwaukee Bucks", 0.68), away: T("Miami Heat", 0.55), inMinutes: 70 },
  { lg: NBA, home: T("Detroit Pistons", 0.28), away: T("New York Knicks", 0.7), inMinutes: 110 },
  { lg: NBA, home: T("Phoenix Suns", 0.5), away: T("Dallas Mavericks", 0.56), inMinutes: 160 },
  { lg: NBA, home: T("Charlotte Hornets", 0.2), away: T("Cleveland Cavaliers", 0.74), inMinutes: 230 },
  { lg: EUR, home: T("Real Madrid", 0.8), away: T("Olympiacos", 0.66), inMinutes: 45, hot: true },
  { lg: EUR, home: T("Fenerbahce", 0.72), away: T("Partizan", 0.4), inMinutes: 130 },
  { lg: EUR, home: T("FC Barcelona", 0.74), away: T("Anadolu Efes", 0.52), inMinutes: 300 },
];
export function buildBbMatch(seed, idx, now = Date.now()) {
  const len = seed.lg.id === "bb-nba" ? 48 : 40, qL = len / 4;
  const live = seed.inMinutes < 0, target = live ? Math.min(len - 6, -seed.inMinutes) : 0;
  const base = { id: `b${idx + 1}`, real: false, leagueId: seed.lg.id, leagueName: seed.lg.name, leagueLogo: "", country: seed.lg.country, home: { ...seed.home }, away: { ...seed.away }, len, hot: !!seed.hot };
  const m = { ...base, startsAt: live ? now - target * 60000 : now + seed.inMinutes * 60000, status: live ? "live" : "upcoming", minute: 0, period: live ? 1 : 0, score: [0, 0], q: { h: [0, 0, 0, 0, 0], a: [0, 0, 0, 0, 0] }, ot: false };
  if (live) for (let i = 0; i < target; i++) simStep(m);
  return m;
}
function simStep(m) {
  const mod = modelOf({ ...m, status: "upcoming" });
  const lam = (k) => (k / m.len);
  const draw = (l) => Math.max(0, Math.round(l + (Math.random() + Math.random() - 1) * 1.7));
  const ph = draw(lam((mod.tt0 + mod.mm0) / 2)), pa = draw(lam((mod.tt0 - mod.mm0) / 2));
  m.score = [m.score[0] + ph, m.score[1] + pa];
  const qi = m.minute >= m.len ? 4 : Math.min(3, Math.floor(m.minute / (m.len / 4)));
  m.q.h[qi] = (m.q.h[qi] || 0) + ph; m.q.a[qi] = (m.q.a[qi] || 0) + pa;
  m.minute += 1;
  m.period = m.minute > m.len ? 5 : Math.min(4, Math.max(1, Math.ceil(m.minute / (m.len / 4))));
}
/** نبضة واحدة = دقيقة لعب لكل مباراة تجريبية حيّة (غير مجمّدة) — تُعيد قائمة جديدة + المنتهية */
export function tickBb(matches, now = Date.now()) {
  const ended = [];
  const next = matches.map((m0) => {
    if (m0.real || m0.frozen || m0.status === "ended" || m0.status === "void") return m0;
    if (m0.status === "upcoming") {
      if (now < m0.startsAt) return m0;
      return { ...m0, status: "live", minute: 1, period: 1, score: [0, 0], q: { h: [0, 0, 0, 0, 0], a: [0, 0, 0, 0, 0] } };
    }
    const m = { ...m0, score: [...m0.score], q: { h: [...(m0.q?.h || [0, 0, 0, 0, 0])], a: [...(m0.q?.a || [0, 0, 0, 0, 0])] } };
    simStep(m);
    const endMin = m.len + 5 * (m.otN || 0);
    if (m.minute >= endMin) {
      if (m.score[0] === m.score[1]) { m.otN = (m.otN || 0) + 1; m.ot = true; m.period = 5; }
      else { m.status = "ended"; m.endedAt = now; m.minute = Math.min(m.minute, endMin); ended.push(m.id); }
    }
    return m;
  });
  return { matches: next, ended };
}

/** مباراة يضيفها الأدمن يدوياً */
export function manualMatch(body, id, now = Date.now()) {
  const len = Number(body.len) === 40 ? 40 : 48;
  const tm = (t, def) => (typeof t === "string" ? { name: t, nameEn: t, short: shortOf(t) || t.slice(0, 3).toUpperCase(), colors: colorsFor(t), logo: "", strength: def } : { ...t, strength: num(t?.strength) ?? def, colors: t?.colors?.length ? t.colors : colorsFor(t?.name), short: t?.short || shortOf(t?.name) });
  const live = !!body.live, target = live ? clamp(Number(body.minute) || 1, 1, len - 1) : 0;
  const m = {
    id, real: false, leagueId: String(body.leagueId || "bb-custom"), leagueName: String(body.leagueName || "كرة السلة"), leagueLogo: String(body.leagueLogo || ""), country: String(body.country || ""),
    home: tm(body.home, 0.5), away: tm(body.away, 0.5), len, hot: !!body.hot,
    startsAt: live ? now - target * 60000 : body.startsAt ? Number(body.startsAt) : now + (Number(body.inMinutes) || 60) * 60000,
    status: live ? "live" : "upcoming", minute: 0, period: live ? 1 : 0, score: [0, 0], q: { h: [0, 0, 0, 0, 0], a: [0, 0, 0, 0, 0] }, ot: false,
  };
  if (live) for (let i = 0; i < target; i++) simStep(m);
  return m;
}
