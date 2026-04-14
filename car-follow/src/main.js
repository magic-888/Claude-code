import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, get, onValue, remove } from 'firebase/database';

// ═══════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
//  ─────────────────────────────────────────────────────────────
//  1. Visit https://console.firebase.google.com
//  2. Create a project → Project settings → Add web app
//  3. Enable "Realtime Database" → Start in test mode
//  4. Paste your config values below and reload
// ═══════════════════════════════════════════════════════════════
const FIREBASE_CONFIG = {
    apiKey:            "YOUR_API_KEY",
    authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
    databaseURL:       "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
    projectId:         "YOUR_PROJECT_ID",
    storageBucket:     "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId:             "YOUR_APP_ID",
};
// ═══════════════════════════════════════════════════════════════

// ── Firebase init ─────────────────────────────────────────────
const configured = !FIREBASE_CONFIG.apiKey.startsWith('YOUR');
let db = null;

if (configured) {
    db = getDatabase(initializeApp(FIREBASE_CONFIG));
} else {
    document.getElementById('setup-notice').style.display = 'flex';
}

// ── Leaflet map references ────────────────────────────────────
let hostMap    = null;
let followMap  = null;
let hostDot    = null;
let selfDot    = null;
let targetDot  = null;

// ── State ─────────────────────────────────────────────────────
let mode          = 'none';
let sessionCode   = null;
let myLat = null, myLng = null;
let hostLat = null, hostLng = null;
let geoWatchId    = null;
let unsubscribeFn = null;
let tickTimer     = null;

// ── Screen helpers ────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// ── HOME ──────────────────────────────────────────────────────
window.goHome = () => {
    teardown();
    showScreen('home');
};

// ── HOST ──────────────────────────────────────────────────────
window.goHost = () => {
    if (!configured) return;
    mode = 'host';
    sessionCode = String(Math.floor(100000 + Math.random() * 900000));
    document.getElementById('host-code').textContent = sessionCode;
    showScreen('host');

    setTimeout(() => {
        if (!hostMap) {
            hostMap = L.map('host-map', { zoomControl: false, attributionControl: false });
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                { maxZoom: 19 }).addTo(hostMap);
            hostMap.setView([51.5, -0.09], 14);
        }
        hostMap.invalidateSize();
    }, 50);

    setHostStatus('acquiring');
    if (!navigator.geolocation) {
        setHostStatus('error', 'GPS not available on this device');
        return;
    }
    geoWatchId = navigator.geolocation.watchPosition(onHostGPS, onGPSErr,
        { enableHighAccuracy: true, maximumAge: 2000 });
};

function onHostGPS({ coords }) {
    const { latitude: lat, longitude: lng, speed } = coords;
    myLat = lat; myLng = lng;
    setHostStatus('ok', `${lat.toFixed(5)}, ${lng.toFixed(5)}`);

    set(ref(db, `sessions/${sessionCode}`), {
        lat, lng,
        speed: speed != null ? Math.round(speed * 3.6) : 0,
        ts: Date.now(),
    });

    if (hostMap) {
        if (!hostDot) {
            hostDot = L.circleMarker([lat, lng], markerStyle('#60a5fa', 9)).addTo(hostMap);
        } else {
            hostDot.setLatLng([lat, lng]);
        }
        hostMap.setView([lat, lng]);
    }
}

function setHostStatus(state, msg) {
    const pulse = document.getElementById('host-pulse');
    const label = document.getElementById('host-status');
    pulse.className = 'pulse';
    if (state === 'ok')         { pulse.classList.add('on');  label.textContent = msg || 'Sharing live'; }
    else if (state === 'error') { pulse.classList.add('err'); label.textContent = msg || 'GPS error'; }
    else                        { label.textContent = 'Waiting for GPS…'; }
}

window.copyLink = () => {
    navigator.clipboard.writeText(buildShareURL()).then(() => toast('Link copied!'));
};

window.shareNative = () => {
    const url = buildShareURL();
    if (navigator.share) {
        navigator.share({ title: 'CarFollow', text: `Follow me — code ${sessionCode}`, url });
    } else {
        navigator.clipboard.writeText(url).then(() => toast('Link copied!'));
    }
};

function buildShareURL() {
    return `${location.origin}${location.pathname}?code=${sessionCode}`;
}

// ── FOLLOW ────────────────────────────────────────────────────
window.goFollow = () => {
    if (!configured) return;
    mode = 'follow';
    showScreen('follow');

    const urlCode = new URLSearchParams(location.search).get('code');
    if (urlCode) {
        document.getElementById('code-input').value = urlCode;
        setTimeout(joinSession, 120);
    }
};

window.joinSession = async () => {
    const code  = document.getElementById('code-input').value.trim();
    const errEl = document.getElementById('join-err');
    errEl.textContent = '';

    if (code.length !== 6 || isNaN(Number(code))) {
        errEl.textContent = 'Enter the 6-digit code from the host.';
        return;
    }

    const snap = await get(ref(db, `sessions/${code}`)).catch(() => null);
    if (!snap || !snap.exists()) {
        errEl.textContent = 'Session not found. Check the code and try again.';
        return;
    }

    sessionCode = code;

    document.getElementById('code-entry').style.display = 'none';
    const activeEl = document.getElementById('follow-active');
    activeEl.style.cssText = 'display:flex; flex-direction:column; height:100%';

    await tick();
    if (!followMap) {
        followMap = L.map('follow-map', { zoomControl: false, attributionControl: false });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            { maxZoom: 19 }).addTo(followMap);
        followMap.setView([51.5, -0.09], 14);
    }
    followMap.invalidateSize();

    if (navigator.geolocation) {
        geoWatchId = navigator.geolocation.watchPosition(({ coords }) => {
            myLat = coords.latitude; myLng = coords.longitude;
            if (!selfDot) {
                selfDot = L.circleMarker([myLat, myLng], markerStyle('#60a5fa', 8))
                    .bindTooltip('You', { permanent: false }).addTo(followMap);
            } else {
                selfDot.setLatLng([myLat, myLng]);
            }
            fitMap();
            updateInfoStrip();
        }, onGPSErr, { enableHighAccuracy: true, maximumAge: 3000 });
    }

    unsubscribeFn = onValue(ref(db, `sessions/${sessionCode}`), snap => {
        if (!snap.exists()) return;
        const { lat, lng, speed } = snap.val();
        hostLat = lat; hostLng = lng;

        if (!targetDot) {
            targetDot = L.circleMarker([lat, lng], markerStyle('#4ade80', 11))
                .bindTooltip('Host', { permanent: true, direction: 'top', offset: [0, -12] })
                .addTo(followMap);
        } else {
            targetDot.setLatLng([lat, lng]);
        }

        fitMap();
        updateInfoStrip(speed);
    });

    tickTimer = setInterval(updateInfoStrip, 1000);
};

window.leaveSession = () => {
    teardown();
    showScreen('follow');
    document.getElementById('code-entry').style.display = 'flex';
    document.getElementById('follow-active').style.display = 'none';
    document.getElementById('code-input').value = '';
    document.getElementById('join-err').textContent = '';
};

window.openNav = () => {
    if (hostLat == null) return;
    window.open(
        `https://www.google.com/maps/dir/?api=1&destination=${hostLat},${hostLng}&travelmode=driving`,
        '_blank'
    );
};

function updateInfoStrip(speed) {
    if (hostLat == null) return;

    if (myLat != null) {
        const km = haversine(myLat, myLng, hostLat, hostLng);
        document.getElementById('dist-val').textContent =
            km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;

        const deg = bearing2D(myLat, myLng, hostLat, hostLng);
        document.getElementById('dir-arrow').style.transform = `rotate(${deg}deg)`;
    }

    if (speed != null) {
        document.getElementById('speed-val').textContent =
            speed > 1 ? `${speed} km/h` : 'Stopped';
    }
}

function fitMap() {
    if (!followMap || hostLat == null) return;
    const pts = [[hostLat, hostLng]];
    if (myLat != null) pts.push([myLat, myLng]);
    followMap.fitBounds(L.latLngBounds(pts).pad(0.3));
}

// ── Shared helpers ────────────────────────────────────────────
function onGPSErr(err) { console.warn('GPS:', err.message); }

function markerStyle(color, radius) {
    return { radius, color, fillColor: color, fillOpacity: 0.92, weight: 3 };
}

function teardown() {
    if (geoWatchId != null)  { navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
    if (unsubscribeFn)       { unsubscribeFn(); unsubscribeFn = null; }
    if (tickTimer)           { clearInterval(tickTimer); tickTimer = null; }
    if (sessionCode && mode === 'host') {
        remove(ref(db, `sessions/${sessionCode}`)).catch(() => {});
    }
    sessionCode = null;
    myLat = myLng = hostLat = hostLng = null;
    if (hostDot)   { hostDot.remove();   hostDot = null; }
    if (selfDot)   { selfDot.remove();   selfDot = null; }
    if (targetDot) { targetDot.remove(); targetDot = null; }
    mode = 'none';
}

function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing2D(lat1, lng1, lat2, lng2) {
    const r = Math.PI / 180;
    const dLng = (lng2 - lng1) * r;
    const y = Math.sin(dLng) * Math.cos(lat2 * r);
    const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
              Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function tick() { return new Promise(r => setTimeout(r, 30)); }

function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
}

// Handle shared link on page load
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode && configured) {
    document.getElementById('code-input').value = urlCode;
    showScreen('follow');
    setTimeout(joinSession, 200);
}
