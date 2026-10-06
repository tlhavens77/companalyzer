// Netlify function: property lookup + sold-comp selection via RentCast.
// Set RENTCAST_API_KEY in Netlify > Site settings > Environment variables.

const BASE = "https://api.rentcast.io/v1";

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
  return {
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
  if (c.soldDate) {
    const months = (Date.now() - new Date(c.soldDate)) / (1000 * 60 * 60 * 24 * 30);
    s += months * 1.5;
  }
  return s;
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
      return json(200, normalize(data[0]));
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
      const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
      let ranked = [];
      for (const radius of [1, 3, 5]) {
        const props = await rc(env, "/properties", {
          latitude: lat, longitude: lon, radius,
          propertyType: subject.propertyType,
          limit: 500,
        });
        ranked = props
          .map(normalize)
          .filter((c) => c.soldPrice && c.soldDate && new Date(c.soldDate).getTime() >= cutoff &&
            c.address && c.address.toLowerCase() !== (subject.address || "").toLowerCase())
          .map((c) => {
            const miles = milesBetween(lat, lon, c.latitude, c.longitude);
            return { ...c, miles: Math.round(miles * 100) / 100, _score: score(subject, c, miles) };
          })
          .sort((a, b) => a._score - b._score);
        if (ranked.length >= 5) break;
      }
      return json(200, { comps: ranked.slice(0, 5).map(({ _score, ...c }) => c) });
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
