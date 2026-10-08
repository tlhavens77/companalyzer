// Cloudflare Worker: property lookup + sold-comp selection via RentCast.
// Secret required: RENTCAST_API_KEY (Worker > Settings > Variables and Secrets).

const BASE = "https://api.rentcast.io/v1";
const WINDOWS = [12, 24, 36, 60]; // months, tried in order
const RADII = [1, 3, 5];          // miles, tried in order within each window
const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

async function rc(env, path, params) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url, {
    headers: { "X-Api-Key": env.RENTCAST_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`RentCast ${res.status}: ${await res.text()}`);
  return res.json();
}

function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalize(p) {
  const f = p.features || {};
  const ta = p.taxAssessments || {};
  const taYears = Object.keys(ta).sort();
  const lastTa = taYears.length ? ta[taYears[taYears.length - 1]] : null;
  return {
    state: p.state || "",
    assessedLand: lastTa && lastTa.land != null ? lastTa.land : null,
    assessedImprovements: lastTa && lastTa.improvements != null ? lastTa.improvements : null,
    assessedYear: lastTa ? (lastTa.year || +taYears[taYears.length - 1]) : null,
    address: p.formattedAddress || p.addressLine1,
    latitude: p.latitude,
    longitude: p.longitude,
    propertyType: p.propertyType,
    sqft: p.squareFootage,
    beds: p.bedrooms,
    baths: p.bathrooms,
    yearBuilt: p.yearBuilt,
    roofType: f.roofType || "",
    foundation: f.foundationType || "",
    garage: f.garage ? true : (f.garageSpaces ? true : false),
    garageType: f.garageType || "",
    garageSpaces: f.garageSpaces || 0,
    soldPrice: p.lastSalePrice,
    soldDate: p.lastSaleDate,
  };
}

function score(subject, c, miles) {
  let s = 0;
  if (subject.sqft && c.sqft) s += Math.min(Math.abs(subject.sqft - c.sqft) / subject.sqft, 1) * 40;
  if (subject.yearBuilt && c.yearBuilt) s += Math.min(Math.abs(subject.yearBuilt - c.yearBuilt), 50) * 0.4;
  if (subject.beds != null && c.beds != null) s += Math.abs(subject.beds - c.beds) * 8;
  if (subject.baths != null && c.baths != null) s += Math.abs(subject.baths - c.baths) * 6;
  if (subject.garage !== undefined && !!subject.garage !== !!c.garage) s += 10;
  if (subject.garageType && c.garageType && subject.garageType.toLowerCase() !== c.garageType.toLowerCase()) s += 4;
  if (subject.foundation && c.foundation && subject.foundation.toLowerCase() !== c.foundation.toLowerCase()) s += 6;
  if (subject.roofType && c.roofType && subject.roofType.toLowerCase() !== c.roofType.toLowerCase()) s += 2;
  s += miles * 5;
  if (c.soldDate) s += ((Date.now() - new Date(c.soldDate)) / MONTH_MS) * 1.5;
  return s;
}

const addrKey = (a) => String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Days on market from a RentCast sale listing: use its own figure, else derive from the listing dates.
function domOf(l) {
  if (!l) return null;
  if (l.daysOnMarket != null) return Math.round(l.daysOnMarket);
  if (!l.listedDate) return null;
  const end = l.removedDate ? new Date(l.removedDate) : (l.status === "Active" ? new Date() : null);
  if (!end) return null;
  const d = Math.round((end - new Date(l.listedDate)) / 86400000);
  return d >= 0 ? d : null;
}

const json = (code, body) =>
  new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } });

async function handleComps(request, env) {
  try {
    if (!env.RENTCAST_API_KEY) return json(500, { error: "RENTCAST_API_KEY not set" });
    const body = await request.json().catch(() => ({}));

    if (body.action === "lookup") {
      const data = await rc(env, "/properties", { address: body.address });
      if (!data.length) return json(404, { error: "Address not found" });
      const prop = normalize(data[0]);
      // Days on market is only known if the property is (or was) listed; failure here must not break the lookup.
      const live = await rc(env, "/listings/sale", { address: prop.address, status: "Active", limit: 1 }).catch(() => []);
      prop.daysOnMarket = Array.isArray(live) ? domOf(live[0]) : null;
      return json(200, prop);
    }

    if (body.action === "comps") {
      const subject = body.subject;
      let lat = subject.latitude, lon = subject.longitude;
      if (lat == null) {
        const look = await rc(env, "/properties", { address: subject.address });
        if (!look.length) return json(404, { error: "Address not found" });
        lat = look[0].latitude; lon = look[0].longitude;
        subject.propertyType = subject.propertyType || look[0].propertyType;
      }

      // Each radius is fetched at most once (max 3 API requests), then re-filtered per time window.
      const cache = {};
      const getProps = async (radius) => {
        if (!cache[radius]) {
          cache[radius] = (await rc(env, "/properties", {
            latitude: lat, longitude: lon, radius,
            propertyType: subject.propertyType, limit: 500,
          })).map(normalize);
        }
        return cache[radius];
      };

      const subjAddr = (subject.address || "").toLowerCase();
      let ranked = [], usedMonths = WINDOWS[0], usedRadius = RADII[0], all = [];
      outer:
      for (const months of WINDOWS) {
        const cutoff = Date.now() - months * MONTH_MS;
        for (const radius of RADII) {
          all = await getProps(radius);
          ranked = all
            .filter((c) => c.soldPrice && c.soldDate && c.latitude != null && c.longitude != null &&
              new Date(c.soldDate).getTime() >= cutoff &&
              c.address && c.address.toLowerCase() !== subjAddr)
            .map((c) => {
              const miles = milesBetween(lat, lon, c.latitude, c.longitude);
              return { ...c, miles: Math.round(miles * 100) / 100, _score: score(subject, c, miles) };
            })
            .sort((a, b) => a._score - b._score);
          usedMonths = months; usedRadius = radius;
          if (ranked.length >= 5) break outer;
        }
      }

      // One extra request: past listings around the subject, matched to the comps by address.
      const domMap = {};
      if (ranked.length) {
        try {
          const ls = await rc(env, "/listings/sale", { latitude: lat, longitude: lon, radius: usedRadius, status: "Inactive", limit: 500 });
          for (const l of ls) {
            const k = addrKey(l.formattedAddress || l.addressLine1);
            if (k && !(k in domMap)) domMap[k] = domOf(l); // newest listing first
          }
        } catch (e) {}
      }
      const comps = ranked.slice(0, 5).map(({ _score, ...c }) => ({
        ...c,
        daysOnMarket: domMap[addrKey(c.address)] ?? null,
        ageMonths: Math.round((Date.now() - new Date(c.soldDate)) / MONTH_MS),
      }));
      return json(200, {
        comps,
        searchedMonths: usedMonths,
        searchedRadius: usedRadius,
        diag: {
          properties: all.length,
          withSalePrice: all.filter((c) => c.soldPrice && c.soldDate).length,
          inWindow: ranked.length,
          radiusMiles: usedRadius,
        },
      });
    }

    return json(400, { error: "Unknown action" });
  } catch (e) {
    return json(500, { error: e.message });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/comps") {
      if (request.method !== "POST") return json(405, { error: "Use POST" });
      return handleComps(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
