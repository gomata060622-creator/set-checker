// 店回り：回る店を選んで、出発時刻から閉店に間に合う、いちばん効率のいい回り方を出す
// 店のデータ：data/stores.json（ブックオフは「仕入れマップ」〈MITライセンス、合同会社にしき〉のデータ、古本市場・ふるいちは公式の店舗一覧から）
(function () {
  "use strict";
  const LS = "sc_tour";
  const HOME0 = { name: "家（天神橋筋六丁目）", lat: 34.7107, lng: 135.5115 };
  const AREAS = {
    "北摂": ["豊中市", "吹田市", "茨木市", "高槻市", "箕面市", "池田市", "摂津市", "豊能郡", "三島郡"],
    "北河内": ["枚方市", "寝屋川市", "守口市", "門真市", "大東市", "四條畷市", "交野市"],
    "中河内": ["東大阪市", "八尾市", "柏原市"],
    "南河内": ["松原市", "羽曳野市", "藤井寺市", "富田林市", "河内長野市", "大阪狭山市", "南河内郡"],
    "泉州": ["堺市", "高石市", "泉大津市", "和泉市", "岸和田市", "貝塚市", "泉佐野市", "泉南市", "阪南市", "泉北郡", "泉南郡"],
  };
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  let ST = null, loading = null, map = null, layer = null, mapEl = null;
  let S = { home: HOME0, mode: "area", pref: "大阪府", cities: [], area: "", center: null, radius: 5, picked: [], off: [], dep: "10:00", stay: 60, speed: 20, back: true, groups: 1, g: 0, my: [], day: null, never: [], date: "", star: [], unstar: [] };
  try { Object.assign(S, JSON.parse(localStorage.getItem(LS) || "{}")); } catch (e) {}
  if (!S.stay60) { S.stay = 60; S.stay60 = true; } // 1店60分を標準にした（2026-11-13）
  ["never", "star", "unstar", "picked", "off", "my", "cities"].forEach((k) => { if (!Array.isArray(S[k])) S[k] = []; });
  // 星：大阪・京都・奈良・兵庫の店は最初から星つき（外したものは unstar に入る）
  const STAR_PREFS = ["大阪府", "京都府", "奈良県", "兵庫県"];
  // 兵庫は姫路の手前（高砂・加古川）まで。姫路市とそれより西は最初は星なし
  const starDefault = (s) => STAR_PREFS.includes(s.pref) && !(s.pref === "兵庫県" && s.lng < 134.76);
  const starred = (s) => S.unstar.includes(s.id) ? false : starDefault(s) || S.star.includes(s.id);
  const toggleStar = (s) => {
    if (starred(s)) { S.star = S.star.filter((x) => x !== s.id); if (starDefault(s)) S.unstar.push(s.id); }
    else { S.unstar = S.unstar.filter((x) => x !== s.id); if (!starDefault(s)) S.star.push(s.id); }
  };
  // ---------- セール・お知らせ（data/news.json。毎週の更新で新しくする） ----------
  let NEWS = null;
  const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const today = () => ymd(new Date());
  const saleOn = (sale, dstr) => { const d = new Date(dstr + "T00:00:00"); return sale.monthly ? sale.monthly.includes(d.getDate()) : (sale.dates || []).includes(dstr); };
  const salesOf = (s) => NEWS && NEWS.stores && NEWS.stores[s.id] ? NEWS.stores[s.id].map((k) => NEWS.sales.find((x) => x.k === k)).filter(Boolean) : [];
  // これから2週間のセールの日（店ごと）
  function upcoming(days) {
    const out = [];
    if (!NEWS) return out;
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    for (let i = 0; i < days; i++) {
      const d = new Date(d0.getTime() + i * 86400000), ds = ymd(d);
      NEWS.sales.forEach((sale) => {
        if (!saleOn(sale, ds)) return;
        const st = all().filter((x) => (NEWS.stores[x.id] || []).includes(sale.k) && starred(x));
        if (st.length) out.push({ ds, d, sale, st });
      });
    }
    return out;
  }
  // ---------- 道路での移動時間（OSRM・無料。電波がないときや使えないときは目安） ----------
  const DUR = new Map(); let durKey = "", durState = "";
  const pid = (p) => p.id || "home";
  async function fetchDur(pts) {
    const key = pts.map(pid).join(",") + "|" + S.home.lat + "," + S.home.lng;
    if (key === durKey) return;
    durKey = key; durState = "取得中";
    try {
      const url = "https://router.project-osrm.org/table/v1/driving/" + pts.map((p) => p.lng.toFixed(5) + "," + p.lat.toFixed(5)).join(";") + "?annotations=duration,distance";
      const r = await fetch(url);
      const j = await r.json();
      if (j.code !== "Ok") throw new Error(j.code);
      pts.forEach((a, i) => pts.forEach((b, k) => { if (i !== k) DUR.set(pid(a) + ">" + pid(b), { m: j.durations[i][k] / 60, km: j.distances[i][k] / 1000 }); }));
      durState = "道路";
    } catch (e) { durState = "目安"; }
    if (key === durKey) render();
  }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {} };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const toast = (t) => {
    let d = document.getElementById("trToast");
    if (!d) { d = document.createElement("div"); d.id = "trToast"; d.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#333;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:9999;max-width:90%"; document.body.appendChild(d); }
    d.textContent = t; d.hidden = false; clearTimeout(d._t); d._t = setTimeout(() => { d.hidden = true; }, 3500);
  };

  async function load() {
    if (ST) return ST;
    if (!loading) loading = Promise.all([
      fetch("data/stores.json").then((r) => r.json()),
      fetch("data/news.json").then((r) => r.json()).catch(() => null),
    ]).then(([d, n]) => { ST = d.stores; NEWS = n; return ST; });
    return loading;
  }
  const every = () => (ST || []).concat((S.my || []).map((m) => Object.assign({ brand: "自分で足した店", chain: "my" }, m)));
  // 「もう行かない」にした店は、一覧にも地図にも出さない
  const all = () => { const nv = new Set(S.never); return every().filter((s) => !nv.has(s.id)); };

  // ---------- 距離と時間 ----------
  const km = (a, b) => {
    const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const ROAD = 1.3;   // まっすぐの距離 → 道のりの目安
  const road = (a, b) => DUR.get(pid(a) + ">" + pid(b));
  const mins = (a, b) => { const r = road(a, b); return r ? r.m : (km(a, b) * ROAD / Math.max(5, S.speed)) * 60; };
  const dkm = (a, b) => { const r = road(a, b); return r ? r.km : km(a, b) * ROAD; };
  const toMin = (t) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
  const hhmm = (m) => { m = Math.round(m); return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0"); };
  function hoursOf(s, day) {
    const h = s.hrs ? s.hrs[WD[day]] : s.hours;
    const m = String(h || "").normalize("NFKC").match(/(\d{1,2}:\d{2})\s*[~〜～-]\s*(\d{1,2}:\d{2})/);
    if (!m) return null;
    let o = toMin(m[1]), c = toMin(m[2]);
    if (c <= o) c += 24 * 60;
    return { o, c, t: m[1] + "〜" + m[2] };
  }

  // ---------- 回る候補 ----------
  function candidates() {
    const st = all();
    let c = [];
    if (S.mode === "area") {
      const cs = new Set(S.cities.concat(S.area && AREAS[S.area] ? AREAS[S.area] : []));
      c = st.filter((s) => s.pref === S.pref && (cs.size === 0 || [...cs].some((x) => (s.city || "").startsWith(x) || (s.address || "").includes(x))));
    } else if (S.mode === "radius") {
      const ctr = S.center || S.home;
      c = st.filter((s) => km(ctr, s) <= S.radius);
    } else {
      const p = new Set(S.picked);
      c = st.filter((s) => p.has(s.id));
    }
    const off = new Set(S.off);
    return c.filter((s) => !off.has(s.id) && !notOpen(s));
  }

  // まだ開店していない店（「2027年2月中旬グランドオープン」「12月10日オープン予定」など）は外す
  function notOpen(s) {
    const m = String(s.note || "").match(/(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?/);
    if (!m) return false;
    const d = new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 28);
    return d > new Date();
  }
  // 近い店どうしでいくつかに分ける（k-means）。名前は家から見た方角
  function split(list, k) {
    if (k <= 1 || list.length <= k) return [list];
    const sorted = list.slice().sort((a, b) => a.lat - b.lat);
    let ctr = Array.from({ length: k }, (_, i) => Object.assign({}, sorted[Math.floor((i + 0.5) * sorted.length / k)]));
    let asg = [];
    for (let it = 0; it < 30; it++) {
      asg = list.map((s) => { let bi = 0, bd = 1e9; ctr.forEach((c, i) => { const d = km(s, c); if (d < bd) { bd = d; bi = i; } }); return bi; });
      ctr = ctr.map((c, i) => { const m = list.filter((_, j) => asg[j] === i); return m.length ? { lat: m.reduce((a, s) => a + s.lat, 0) / m.length, lng: m.reduce((a, s) => a + s.lng, 0) / m.length } : c; });
    }
    const gs = ctr.map((c, i) => ({ c, l: list.filter((_, j) => asg[j] === i) })).filter((g) => g.l.length);
    gs.forEach((g) => { g.name = dirName(g.c, gs); });
    return gs;
  }
  function dirName(c, gs) {
    const lat = gs.reduce((a, g) => a + g.c.lat, 0) / gs.length, lng = gs.reduce((a, g) => a + g.c.lng, 0) / gs.length;
    const dy = c.lat - lat, dx = (c.lng - lng) * Math.cos(lat * Math.PI / 180);
    if (Math.abs(dy) < 0.003 && Math.abs(dx) < 0.003) return "まん中";
    const a = Math.atan2(dy, dx) * 180 / Math.PI;
    return a >= 67.5 && a < 112.5 ? "北側" : a >= 22.5 && a < 67.5 ? "北東側" : a >= -22.5 && a < 22.5 ? "東側" : a >= -67.5 && a < -22.5 ? "南東側" : a >= -112.5 && a < -67.5 ? "南側" : a >= -157.5 && a < -112.5 ? "南西側" : a >= 112.5 && a < 157.5 ? "北西側" : "西側";
  }

  // ---------- 回り方を決める ----------
  // 閉店に間に合う店だけで、なるべく多く回れる順を作る（安く足せる店から順に差し込む → 2-opt で縮める）
  function simulate(order, day) {
    let t = toMin(S.dep) || 600, pos = S.home, rows = [], ok = true;
    for (const s of order) {
      t += mins(pos, s);
      const h = hoursOf(s, day);
      let wait = 0;
      if (h && t < h.o) { wait = h.o - t; t = h.o; }
      const arr = t;
      if (h && arr + S.stay > h.c) ok = false;
      rows.push({ s, arr, wait, h, km: dkm(pos, s) });
      t += S.stay; pos = s;
    }
    const backMin = S.back ? mins(pos, S.home) : 0;
    return { ok, rows, end: t + backMin, back: S.back ? dkm(pos, S.home) : 0 };
  }
  const cost = (order, day) => { const r = simulate(order, day); return r.ok ? r.end : Infinity; };
  function plan(list, day, limitEnd) {
    let order = [], rest = list.slice();
    const lim = limitEnd != null ? limitEnd : 24 * 60 * 2;
    while (rest.length) {
      let best = null;
      for (const s of rest) {
        for (let i = 0; i <= order.length; i++) {
          const o = order.slice(0, i).concat([s], order.slice(i));
          const c = cost(o, day);
          if (c <= lim && (!best || c < best.c)) best = { o, c, s };
        }
      }
      if (!best) break;
      order = best.o; rest = rest.filter((x) => x !== best.s);
    }
    // 2-opt
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) {
        const o = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        if (cost(o, day) + 0.01 < cost(order, day)) { order = o; improved = true; }
      }
    }
    return { order, left: list.filter((s) => !order.includes(s)), sim: simulate(order, day) };
  }

  // ---------- 書き出し ----------
  function csvTS(order, sim) {
    // ツーリングサポーターのMy地点：WKT,名前,説明（カンマ・改行なし、40文字まで）
    const cl = (t) => String(t).replace(/[,\r\n"]/g, " ").slice(0, 40);
    let s = "WKT,名前,説明\r\n";
    order.forEach((st, i) => {
      const r = sim.rows[i];
      s += "POINT (" + st.lng + " " + st.lat + ")," + cl(String(i + 1).padStart(2, "0") + " " + st.name) + "," + cl(hhmm(r.arr) + "着 " + (r.h ? "営業" + r.h.t : "")) + "\r\n";
    });
    return s;
  }
  function download(name, text) {
    const b = new Blob([text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function gmapLinks(order) {
    // Googleマップは経由地9か所まで。多いときは分ける
    const pts = order.map((s) => s.lat + "," + s.lng), home = S.home.lat + "," + S.home.lng;
    const out = [];
    let start = home, i = 0;
    while (i < pts.length) {
      const chunk = pts.slice(i, i + 9);
      i += chunk.length;
      const last = i >= pts.length;
      const dest = last && S.back ? home : chunk[chunk.length - 1];
      const wps = last && S.back ? chunk : chunk.slice(0, -1);
      out.push("https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=" + encodeURIComponent(start) + "&destination=" + encodeURIComponent(dest) + (wps.length ? "&waypoints=" + encodeURIComponent(wps.join("|")) : ""));
      start = chunk[chunk.length - 1];
    }
    return out;
  }

  // ---------- 地図 ----------
  function ensureLeaflet() {
    if (window.L) return Promise.resolve();
    return new Promise((res, rej) => {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "leaflet.css"; document.head.appendChild(l);
      const s = document.createElement("script"); s.src = "leaflet.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }
  async function drawMap(el, cands, order, onTap) {
    try { await ensureLeaflet(); } catch (e) { el.innerHTML = '<div class="note">地図を読み込めませんでした（電波がないと地図は出ません）</div>'; return; }
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    map = L.map(el, { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    layer = L.layerGroup().addTo(map);
    const pts = [[S.home.lat, S.home.lng]];
    L.marker([S.home.lat, S.home.lng], { icon: L.divIcon({ className: "tr-pin tr-home", html: "家", iconSize: [26, 26] }) }).addTo(layer);
    const idx = new Map(order.map((s, i) => [s.id, i + 1]));
    const near = all().filter((s) => cands.length && cands.some((c) => km(c, s) < 15));
    const show = S.mode === "pick" ? all().filter((s) => km(S.center || S.home, s) < 40) : near.length ? near : cands;
    const cset = new Set(cands.map((s) => s.id));
    show.forEach((s) => {
      const n = idx.get(s.id), inC = cset.has(s.id), off = S.off.includes(s.id);
      const cls = "tr-pin " + (n ? "tr-on" : inC ? "tr-cand" : off ? "tr-off" : "tr-other") + (s.chain === "furuichi" ? " tr-fr" : s.chain === "my" ? " tr-my" : "");
      const m = L.marker([s.lat, s.lng], { icon: L.divIcon({ className: cls, html: n ? String(n) : "", iconSize: n ? [24, 24] : [14, 14] }) }).addTo(layer);
      m.bindTooltip((starred(s) ? "★" : "") + esc(s.name) + (s.note ? "<br>" + esc(s.note) : "") + (salesOf(s).some((x) => saleOn(x, S.date)) ? "<br>この日セール" : ""));
      m.on("click", () => onTap(s));
      if (n || inC) pts.push([s.lat, s.lng]);
    });
    if (order.length) L.polyline([[S.home.lat, S.home.lng]].concat(order.map((s) => [s.lat, s.lng])).concat(S.back ? [[S.home.lat, S.home.lng]] : []), { color: "#c0392b", weight: 3, opacity: 0.7 }).addTo(layer);
    if (S.mode === "radius") L.circle([(S.center || S.home).lat, (S.center || S.home).lng], { radius: S.radius * 1000, color: "#1a5fb4", weight: 1, fillOpacity: 0.05 }).addTo(layer);
    map.on("click", (e) => { if (S.mode === "radius" && S.pickCenter) { S.center = { lat: e.latlng.lat, lng: e.latlng.lng, name: "地図で選んだ所" }; S.pickCenter = false; save(); render(); } else if (S.pickHome) { S.home = { lat: e.latlng.lat, lng: e.latlng.lng, name: "地図で選んだ出発地" }; S.pickHome = false; save(); render(); } });
    if (pts.length > 1) map.fitBounds(pts, { padding: [20, 20] }); else map.setView(pts[0], 12);
  }

  // ---------- 画面 ----------
  let host = null;
  async function render(el) {
    if (el) host = el;
    const main = host;
    if (!main) return;
    if (!ST) { main.innerHTML = '<div class="empty"><b>店のデータを読み込んでいます…</b></div>'; try { await load(); } catch (e) { main.innerHTML = '<div class="empty"><b>店のデータを読み込めませんでした</b><div class="note">一度電波のある所で開いてください。</div></div>'; return; } }
    if (!S.date || S.date < today()) S.date = today();
    const day = new Date(S.date + "T00:00:00").getDay();
    const cands = candidates();
    const groups = split(cands, S.groups);
    const gi = Math.min(S.g, groups.length - 1);
    let grp = groups.length > 1 ? groups[gi].l : cands;
    const MAX = 40;
    let capped = 0;
    if (grp.length > MAX) { capped = grp.length; grp = grp.slice().sort((a, b) => km(S.home, a) - km(S.home, b)).slice(0, MAX); }
    if (grp.length && navigator.onLine !== false) fetchDur([S.home].concat(grp));
    const res = plan(grp, day);
    const prefs = [...new Set(all().map((s) => s.pref))].filter(Boolean);
    const cities = [...new Set(all().filter((s) => s.pref === S.pref).map((s) => cityKey(s)))].sort((a, b) => a.localeCompare(b, "ja"));
    let h = '<section class="tr">';
    h += '<div class="callout"><div><b>店回り</b>（回る店を選ぶと、閉店に間に合う効率のいい順を出します）</div>' +
      '<div class="note">出発：' + esc(S.home.name) + '　<button type="button" class="purchbtn" id="trHomeHere">現在地にする</button> <button type="button" class="purchbtn" id="trHomeMap">地図で選ぶ</button> <button type="button" class="purchbtn" id="trHomeReset">家に戻す</button></div></div>';
    // セール・イベントの一覧（星の店だけ）
    const up = upcoming(14);
    if (up.length || (NEWS && NEWS.news && NEWS.news.length)) {
      h += '<details class="tr-box" open><summary><b>セール・イベント（星の店・2週間）</b></summary>';
      up.forEach((u, i) => {
        const prefs = {}; u.st.forEach((x) => { const k = x.pref.replace(/[府県]$/, "") + " " + cityKey(x).replace(/^大阪市/, ""); prefs[k] = (prefs[k] || 0) + 1; });
        h += '<div class="tr-ev"><b>' + (u.d.getMonth() + 1) + "/" + u.d.getDate() + "(" + WD[u.d.getDay()] + ")</b> " + esc(u.sale.t) + "　" + u.st.length + "店" +
          '<div class="note">' + Object.entries(prefs).map(([k, n]) => esc(k) + (n > 1 ? "×" + n : "")).join("・") + '</div><button type="button" class="purchbtn" data-ev="' + i + '">この日にこの店を回る</button></div>';
      });
      if (NEWS && NEWS.news) NEWS.news.forEach((n) => { h += '<div class="note">' + esc(n.d.slice(5).replace("-", "/")) + " " + esc(n.t) + "</div>"; });
      h += '<div class="note">' + esc((NEWS && NEWS.made) || "") + "時点のブックオフの各店ページから（毎週更新）</div></details>";
    }
    // 範囲
    h += '<div class="tr-box"><div class="tr-tabs">' + [["area", "地域"], ["radius", "中心と半径"], ["pick", "地図で選ぶ"]].map(([k, t]) => '<button type="button" class="purchbtn' + (S.mode === k ? " dcon" : "") + '" data-mode="' + k + '">' + t + "</button>").join("") + "</div>";
    if (S.mode === "area") {
      h += '<div class="tr-row"><select id="trPref">' + prefs.map((p) => '<option' + (p === S.pref ? " selected" : "") + ">" + esc(p) + "</option>").join("") + "</select>";
      if (S.pref === "大阪府") h += Object.keys(AREAS).map((a) => '<button type="button" class="purchbtn' + (S.area === a ? " dcon" : "") + '" data-area="' + a + '">' + a + "</button>").join("");
      h += '</div><details' + (S.cities.length ? " open" : "") + '><summary>市区町村で選ぶ' + (S.cities.length ? "（" + S.cities.length + "）" : "") + '</summary><div class="tr-cities">' + cities.map((c) => '<label><input type="checkbox" data-city="' + esc(c) + '"' + (S.cities.includes(c) ? " checked" : "") + ">" + esc(c) + "</label>").join("") + "</div></details>";
      h += '<div class="note">市区町村を選ばないと、県の全部の店が候補になります。</div>';
    } else if (S.mode === "radius") {
      h += '<div class="tr-row">中心：' + esc((S.center || S.home).name || "") + ' <button type="button" class="purchbtn" id="trCtrMap">地図で選ぶ</button> <button type="button" class="purchbtn" id="trCtrHere">現在地</button> <button type="button" class="purchbtn" id="trCtrHome">出発地</button></div>' +
        '<div class="tr-row">半径 <input type="range" id="trRad" min="1" max="30" step="1" value="' + S.radius + '"> <b>' + S.radius + "km</b></div>";
      if (S.pickCenter) h += '<div class="note"><b>地図の上で中心にしたい所を押してください</b></div>';
    } else {
      h += '<div class="note">地図の店を押すと、回る店に入れたり外したりできます（' + S.picked.length + '店を選択中）。 <button type="button" class="purchbtn" id="trPickClear">選んだ店を全部外す</button></div>';
    }
    if (S.pickHome) h += '<div class="note"><b>地図の上で出発地を押してください</b></div>';
    h += "</div>";
    // 条件
    h += '<div class="tr-box tr-row">' +
      '日 <input type="date" id="trDate" value="' + esc(S.date) + '"> (' + WD[day] + ")" +
      ' 出発 <input type="time" id="trDep" value="' + esc(S.dep) + '">' +
      ' 1店 <select id="trStay">' + [15, 20, 30, 40, 45, 60, 90].map((m) => '<option' + (m === S.stay ? " selected" : "") + ">" + m + "</option>").join("") + "</select>分" +
      ' 速さ <select id="trSpd">' + [15, 20, 25, 30, 40].map((m) => '<option' + (m === S.speed ? " selected" : "") + ">" + m + "</option>").join("") + "</select>km/h" +
      ' <label><input type="checkbox" id="trBack"' + (S.back ? " checked" : "") + ">出発地に戻る</label>" +
      ' 分ける <select id="trGrp">' + [1, 2, 3, 4].map((n) => '<option' + (n === S.groups ? " selected" : "") + ">" + n + "</option>").join("") + "</select>つ</div>";
    if (groups.length > 1) h += '<div class="tr-tabs">' + groups.map((g, i) => '<button type="button" class="purchbtn' + (i === gi ? " dcon" : "") + '" data-g="' + i + '">' + esc(g.name) + "（" + g.l.length + "店）</button>").join("") + "</div>";
    // 地図
    h += '<div id="trMap" class="tr-map"></div>';
    // 結果
    const sim = res.sim;
    if (capped) h += '<div class="note"><b>候補が' + capped + '店あるので、出発地に近い' + MAX + '店で計算しています。</b>範囲をしぼるか「分ける」を増やしてください。</div>';
    const dnote = durState === "道路" && grp.every((x) => road(S.home, x)) ? "移動時間は道路で計算" : durState === "取得中" ? "道路の時間を調べています…" : "移動時間は目安（まっすぐの距離×1.3）";
    h += '<div class="note">' + dnote + "</div>";
    h += '<div class="tr-sum">候補 ' + grp.length + "店のうち <b>" + res.order.length + "店</b> 回れます" + (res.order.length ? "（" + hhmm(toMin(S.dep)) + "出発 → " + hhmm(sim.end) + (S.back ? "帰着" : "最後の店を出る") + "）" : "") + "</div>";
    if (res.order.length) {
      h += '<ol class="tr-list">' + sim.rows.map((r, i) => '<li><b>' + hhmm(r.arr) + "</b>着 " + esc(r.s.name) + '<div class="note">' + (r.h ? "営業 " + esc(r.h.t) : "営業時間不明") + (r.s.note ? "　<b>" + esc(r.s.note) + "</b>" : "") + saleBadge(r.s) + (r.wait > 0 ? "（開店まで" + Math.round(r.wait) + "分待ち）" : "") + "　前から約" + r.km.toFixed(1) + "km・" + esc(r.s.address || "") + ' <button type="button" class="purchbtn" data-off="' + esc(r.s.id) + '">今日は外す</button> <button type="button" class="purchbtn" data-never="' + esc(r.s.id) + '">もう行かない</button> ' + starBtn(r.s) + "</div></li>").join("") + "</ol>";
      if (S.back) h += '<div class="note">最後の店から出発地まで約' + sim.back.toFixed(1) + "km</div>";
      h += '<div class="actions"><button type="button" class="btn btn-primary" id="trCsv">ツーリングサポーター用に書き出す</button></div>';
      h += '<div class="actions">' + gmapLinks(res.order).map((u, i, a) => '<a class="btn" target="_blank" rel="noopener" href="' + esc(u) + '">Googleマップで開く' + (a.length > 1 ? "（" + (i + 1) + "/" + a.length + "）" : "") + "</a>").join("") + "</div>";
      h += '<div class="note">書き出したCSVは、ツーリングサポーターのWeb版マイページの「My地点」→「地点をインポート」で取り込めます（1回100件まで）。経由地は8か所までなので、9店以上の日はルートを分けてください。移動時間は、まっすぐの距離×1.3を速さで割った目安です。</div>';
    }
    if (res.left.length) h += '<div class="tr-box"><b>時間内に回れない店（' + res.left.length + "店）</b>" + res.left.map((s) => '<div class="note">' + esc(s.name) + "（" + ((hoursOf(s, day) || {}).t || "営業時間不明") + "）" + (s.note ? " " + esc(s.note) : "") + saleBadge(s) + ' <button type="button" class="purchbtn" data-never="' + esc(s.id) + '">もう行かない</button> ' + starBtn(s) + "</div>").join("") + "</div>";
    if (S.off.length) h += '<div class="note">今日は外した店 ' + S.off.length + '店 <button type="button" class="purchbtn" id="trOffClear">外した店を戻す</button></div>';
    if (S.never.length) { const byId = new Map(every().map((x) => [x.id, x])); h += '<details class="tr-box"><summary>もう行かない店（' + S.never.length + '店）</summary>' + S.never.map((id) => '<div class="note">' + esc((byId.get(id) || {}).name || id) + ' <button type="button" class="purchbtn" data-unnever="' + esc(id) + '">戻す</button></div>').join("") + "</details>"; }
    // 自分で足す店
    h += '<details class="tr-box"><summary>店を自分で足す（' + (S.my || []).length + "店）</summary>" +
      '<div class="tr-row"><input id="trMyName" placeholder="店の名前"><input id="trMyAddr" placeholder="住所"><input id="trMyHrs" placeholder="10:00~20:00" size="11"><button type="button" class="purchbtn" id="trMyAdd">住所で足す</button></div>' +
      '<div class="note">住所から地図の位置を調べます（国土地理院のしくみ・電波が要ります）。</div>' +
      (S.my || []).map((m) => '<div class="note">' + esc(m.name) + "　" + esc(m.address) + ' <button type="button" class="purchbtn" data-mydel="' + esc(m.id) + '">消す</button></div>').join("") + "</details>";
    h += '<div class="note">ブックオフの店のデータは「仕入れマップ」（合同会社にしき・MITライセンス）から、古本市場・ふるいちは公式の店舗一覧から作っています。</div></section>';
    main.innerHTML = h;
    bind(main, res, up);
    mapEl = main.querySelector("#trMap");
    drawMap(mapEl, cands, res.order, (s) => {
      if (S.mode === "pick") { const i = S.picked.indexOf(s.id); if (i >= 0) S.picked.splice(i, 1); else S.picked.push(s.id); }
      else { const i = S.off.indexOf(s.id); if (i >= 0) S.off.splice(i, 1); else if (cands.some((c) => c.id === s.id)) S.off.push(s.id); else { toast("範囲の外の店です。「地図で選ぶ」にすると自由に選べます"); return; } }
      save(); render();
    });
  }
  function saleBadge(s) {
    const L = salesOf(s);
    if (!L.length) return "";
    const on = L.filter((x) => saleOn(x, S.date));
    return (on.length ? '　<span class="tr-sale">この日：' + on.map((x) => esc(x.t)).join("／") + "</span>" : "") + (L.length > on.length ? '　<span class="tr-sale2">' + L.filter((x) => !on.includes(x)).map((x) => esc(x.t.replace(/（.*/, "")) + (x.monthly ? "（毎月" + x.monthly.join("・") + "日）" : x.dates ? "（" + x.dates.map((d) => d.slice(5).replace("-", "/")).join("・") + "）" : "")).join("／") + "</span>" : "");
  }
  const starBtn = (s) => '<button type="button" class="purchbtn tr-star" data-star="' + esc(s.id) + '">' + (starred(s) ? "★" : "☆") + "</button>";
  const cityKey = (s) => { const c = s.city || ""; const m = c.match(/^(.+?市)(.+区)$/); return m && m[1] !== "大阪市" ? m[1] : c; };
  AREAS["大阪市内"] = ["大阪市"];

  function bind(main, res, up) {
    const $ = (id) => main.querySelector("#" + id);
    const on = (id, ev, f) => { const e = $(id); if (e) e.addEventListener(ev, f); };
    const re = () => { save(); render(); };
    main.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { S.mode = b.dataset.mode; S.g = 0; re(); }));
    main.querySelectorAll("[data-area]").forEach((b) => b.addEventListener("click", () => { S.area = S.area === b.dataset.area ? "" : b.dataset.area; S.cities = []; S.g = 0; re(); }));
    main.querySelectorAll("[data-city]").forEach((b) => b.addEventListener("change", () => { const c = b.dataset.city; S.cities = b.checked ? S.cities.concat([c]) : S.cities.filter((x) => x !== c); S.area = ""; S.g = 0; re(); }));
    main.querySelectorAll("[data-g]").forEach((b) => b.addEventListener("click", () => { S.g = +b.dataset.g; re(); }));
    main.querySelectorAll("[data-off]").forEach((b) => b.addEventListener("click", () => { S.off.push(b.dataset.off); re(); }));
    main.querySelectorAll("[data-ev]").forEach((b) => b.addEventListener("click", () => { const u = up[+b.dataset.ev]; S.mode = "pick"; S.picked = u.st.map((x) => x.id); S.date = u.ds; S.groups = 1; S.g = 0; re(); window.scrollTo(0, 0); }));
    main.querySelectorAll("[data-star]").forEach((b) => b.addEventListener("click", () => { const st = all().find((x) => x.id === b.dataset.star); if (st) toggleStar(st); re(); }));
    main.querySelectorAll("[data-never]").forEach((b) => b.addEventListener("click", () => { if (!S.never.includes(b.dataset.never)) S.never.push(b.dataset.never); S.picked = S.picked.filter((x) => x !== b.dataset.never); re(); }));
    main.querySelectorAll("[data-unnever]").forEach((b) => b.addEventListener("click", () => { S.never = S.never.filter((x) => x !== b.dataset.unnever); re(); }));
    main.querySelectorAll("[data-mydel]").forEach((b) => b.addEventListener("click", () => { S.my = S.my.filter((m) => m.id !== b.dataset.mydel); re(); }));
    on("trPref", "change", (e) => { S.pref = e.target.value; S.cities = []; S.area = ""; S.g = 0; re(); });
    on("trRad", "change", (e) => { S.radius = +e.target.value; S.g = 0; re(); });
    on("trDate", "change", (e) => { S.date = e.target.value || today(); re(); });
    on("trDep", "change", (e) => { S.dep = e.target.value || "10:00"; re(); });
    on("trStay", "change", (e) => { S.stay = +e.target.value; re(); });
    on("trSpd", "change", (e) => { S.speed = +e.target.value; re(); });
    on("trBack", "change", (e) => { S.back = e.target.checked; re(); });
    on("trGrp", "change", (e) => { S.groups = +e.target.value; S.g = 0; re(); });
    on("trOffClear", "click", () => { S.off = []; re(); });
    on("trPickClear", "click", () => { S.picked = []; re(); });
    on("trHomeReset", "click", () => { S.home = HOME0; re(); });
    on("trHomeMap", "click", () => { S.pickHome = true; re(); });
    on("trCtrMap", "click", () => { S.pickCenter = true; re(); });
    on("trCtrHome", "click", () => { S.center = null; re(); });
    const here = (f) => { if (!navigator.geolocation) return toast("このスマホでは現在地が取れません"); toast("現在地を調べています…"); navigator.geolocation.getCurrentPosition((p) => { f({ lat: p.coords.latitude, lng: p.coords.longitude }); re(); toast("現在地にしました"); }, () => toast("現在地を取れませんでした"), { enableHighAccuracy: true, timeout: 15000 }); };
    on("trHomeHere", "click", () => here((p) => { S.home = Object.assign(p, { name: "現在地" }); }));
    on("trCtrHere", "click", () => here((p) => { S.center = Object.assign(p, { name: "現在地" }); }));
    on("trCsv", "click", () => { const d = new Date(); download("店回り_" + (d.getMonth() + 1) + "月" + d.getDate() + "日.csv", csvTS(res.order, res.sim)); });
    on("trMyAdd", "click", async () => {
      const name = $("trMyName").value.trim(), addr = $("trMyAddr").value.trim(), hrs = $("trMyHrs").value.trim();
      if (!name || !addr) return toast("店の名前と住所を入れてください");
      try {
        const r = await (await fetch("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(addr))).json();
        if (!r || !r.length) return toast("住所から位置が見つかりませんでした");
        const [lng, lat] = r[0].geometry.coordinates;
        const pm = addr.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/), cm = addr.replace(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/, "").match(/^(.+?[市区町村郡])/);
        S.my.push({ id: "my" + Date.now(), name, address: addr, lat, lng, hours: hrs, pref: pm ? pm[1] : "", city: cm ? cm[1] : "" });
        re();
      } catch (e) { toast("住所を調べられませんでした（電波を確かめてください）"); }
    });
  }

  window.Tour = { render, load };
})();
