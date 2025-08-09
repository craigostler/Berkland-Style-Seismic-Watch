import React, { useEffect, useMemo, useState } from "react";
import SunCalc from "suncalc";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

// Helper: format dates nicely in the user's local timezone
const fmt = (d) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { dateStyle: "medium" });

// Compute moon illumination phase in [0..1], where 0=new, 0.5=full
const moonPhase = (date) => SunCalc.getMoonIllumination(date).phase;

// Compute moon distance (km)
const moonDistanceKm = (date) => SunCalc.getMoonPosition(date, 0, 0).distance;

// Search for syzygy (New or Full Moon) times
function findSyzygies(startDate, daysForward, targetPhase, maxResults = 3) {
  const results = [];
  const start = new Date(startDate);
  const end = new Date(start.getTime() + daysForward * 24 * 3600 * 1000);

  const stepMs = 60 * 60 * 1000; // 1 hour
  let prevDiff = Infinity;
  let prevDate = new Date(start);
  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    const d = new Date(t);
    const diff = Math.abs(moonPhase(d) - targetPhase);
    if (diff > prevDiff) {
      const refined = refinePhaseTime(prevDate, targetPhase);
      if (results.length === 0 || Math.abs(refined.getTime() - results[results.length - 1].getTime()) > 6 * 3600 * 1000) {
        results.push(refined);
        if (results.length >= maxResults) break;
      }
    }
    prevDiff = diff;
    prevDate = d;
  }
  return results;
}

// Refine to exact phase
function refinePhaseTime(seed, targetPhase) {
  let best = new Date(seed);
  let bestDiff = Math.abs(moonPhase(best) - targetPhase);
  let windowMs = 12 * 3600 * 1000;
  for (let i = 0; i < 10; i++) {
    let improved = false;
    for (let k = -4; k <= 4; k++) {
      const d = new Date(best.getTime() + (k * windowMs) / 4);
      const diff = Math.abs(moonPhase(d) - targetPhase);
      if (diff < bestDiff) {
        best = d;
        bestDiff = diff;
        improved = true;
      }
    }
    if (!improved) break;
    windowMs /= 2;
  }
  return best;
}

// Find nearest perigee to date
function estimatePerigeeNear(date) {
  const center = new Date(date);
  const spanDays = 7;
  const stepMs = 2 * 60 * 60 * 1000; // 2 hours
  let best = new Date(center);
  let bestDist = moonDistanceKm(best);
  for (let t = center.getTime() - spanDays * 86400000; t <= center.getTime() + spanDays * 86400000; t += stepMs) {
    const d = new Date(t);
    const dist = moonDistanceKm(d);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return { perigee: best, distanceKm: bestDist };
}

function berklandWindow(center) {
  const c = new Date(center);
  const start = new Date(c.getTime() - 3 * 86400000);
  const end = new Date(c.getTime() + 4 * 86400000);
  return { start, end };
}

const inRange = (d, start, end) => d.getTime() >= start.getTime() && d.getTime() <= end.getTime();

// Fetch earthquakes from USGS
async function fetchEarthquakes(days = 30) {
  const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch USGS feed");
  const data = await res.json();
  const now = Date.now();
  const cutoff = now - days * 86400000;
  return (data.features || [])
    .map((f) => ({
      id: f.id,
      mag: f.properties?.mag ?? null,
      place: f.properties?.place ?? "",
      time: f.properties?.time ? new Date(f.properties.time) : null,
      url: f.properties?.url ?? "",
      coords: f.geometry?.coordinates || null,
    }))
    .filter((q) => q.time && q.time.getTime() >= cutoff)
    .sort((a, b) => b.time - a.time);
}

function useBerklandCalendar() {
  const [now] = useState(new Date());
  const fulls = useMemo(() => findSyzygies(now, 60, 0.5, 2), [now]);
  const news = useMemo(() => findSyzygies(now, 60, 0.0, 2), [now]);
  const syzygies = useMemo(() => {
    return [...fulls.map((d) => ({ type: "Full Moon", date: d })), ...news.map((d) => ({ type: "New Moon", date: d }))]
      .sort((a, b) => a.date - b.date);
  }, [fulls, news]);
  const windows = useMemo(() => {
    return syzygies.slice(0, 2).map((s) => {
      const window = berklandWindow(s.date);
      const { perigee, distanceKm } = estimatePerigeeNear(s.date);
      const deltaDays = Math.abs((s.date - perigee) / 86400000);
      return { ...s, window, perigee, perigeeDistanceKm: distanceKm, perigeeDeltaDays: deltaDays };
    });
  }, [syzygies]);
  const primaryIdx = useMemo(() => {
    if (windows.length < 2) return 0;
    return windows[0].perigeeDeltaDays <= windows[1].perigeeDeltaDays ? 0 : 1;
  }, [windows]);
  return { now, windows, primaryIdx };
}

export default function App() {
  const { now, windows, primaryIdx } = useBerklandCalendar();
  const [quakes, setQuakes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await fetchEarthquakes(30);
        setQuakes(data);
      } catch (e) {
        setError(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const chartData = useMemo(() => {
    const map = new Map();
    quakes.forEach((q) => {
      const key = new Date(q.time.getFullYear(), q.time.getMonth(), q.time.getDate()).toISOString().slice(0, 10);
      map.set(key, (map.get(key) || 0) + 1);
    });
    return Array.from(map.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [quakes]);

  const windowQuakes = (w) => quakes.filter((q) => inRange(q.time, w.window.start, w.window.end));

  return (
    <div className="min-h-screen p-6 bg-gray-50 text-gray-900">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl sm:text-3xl font-bold">🌙 Berkland-Style Seismic Watch</h1>
          <div className="text-sm opacity-70">Now: {fmt(now)}</div>
        </header>

        <section className="grid md:grid-cols-2 gap-4">
          {windows.map((w, idx) => (
            <div key={idx} className={`rounded-2xl p-4 shadow bg-white border ${idx === primaryIdx ? "border-indigo-400" : "border-gray-200"}`}>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xl font-semibold">{w.type} Window</h2>
                {idx === primaryIdx && (
                  <span className="text-xs px-2 py-1 rounded-full bg-indigo-100 text-indigo-700">Primary (closest to perigee)</span>
                )}
              </div>
              <div className="space-y-1 text-sm">
                <div><span className="font-medium">Center:</span> {fmt(w.date)}</div>
                <div><span className="font-medium">Window:</span> {fmt(w.window.start)} → {fmt(w.window.end)} (8 days)</div>
                <div><span className="font-medium">Nearest Perigee:</span> {fmt(w.perigee)} ({w.perigeeDeltaDays.toFixed(2)} days away, ~{Math.round(w.perigeeDistanceKm).toLocaleString()} km)</div>
              </div>
              <div className="mt-3 text-sm">
                <p className="opacity-80">Berkland rule: Watch historically active regions during this window.</p>
              </div>
              <div className="mt-4">
                <h3 className="font-semibold mb-2">Quakes in this window (last 30 days feed)</h3>
                {loading ? (
                  <div className="text-sm opacity-70">Loading quakes…</div>
                ) : error ? (
                  <div className="text-sm text-red-600">{String(error)}</div>
                ) : (
                  <ul className="space-y-1 max-h-48 overflow-auto pr-2">
                    {windowQuakes(w).slice(0, 50).map((q) => (
                      <li key={q.id} className="text-sm flex items-center justify-between">
                        <div>
                          <span className="font-medium">M{q.mag?.toFixed(1) ?? "?"}</span> – {q.place}
                          <span className="opacity-70"> · {fmt(q.time)}</span>
                        </div>
                        <a href={q.url} className="text-indigo-600 hover:underline" target="_blank" rel="noreferrer">USGS</a>
                      </li>
                    ))}
                    {windowQuakes(w).length === 0 && <li className="text-sm opacity-70">No events in feed within this window.</li>}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </section>

        <section className="rounded-2xl p-4 shadow bg-white border border-gray-200">
          <h2 className="text-xl font-semibold mb-2">Earthquakes (past 30 days) — daily counts</h2>
          {loading ? (
            <div className="text-sm opacity-70">Loading chart…</div>
          ) : (
            <div className="w-full h-64">
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} angle={-20} textAnchor="end" height={50} />
                  <YAxis allowDecimals={false} width={40} />
                  <Tooltip />
                  <Line type="monotone" dataKey="count" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <p className="text-xs opacity-70 mt-2">Data source: USGS all-month GeoJSON feed. Timing windows are based on lunar phase and moon distance.</p>
        </section>

        <footer className="text-xs opacity-70">
          This is a research/toy app that mirrors Jim Berkland’s timing rules using lunar phase and perigee estimates. Not a forecast.
        </footer>
      </div>
    </div>
  );
}
