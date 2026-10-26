(() => {
    "use strict";

    const LOCK = "__multiGamePresence";
    const VERSION = "2.1";
    const DETECTABLE_URL = "https://discord.com/api/v9/applications/detectable";
    const MIN_CHANGE_MS = 23 * 60 * 1000;
    const MAX_CHANGE_MS = 38 * 60 * 1000;

    if (window[LOCK]) {
        console.warn("[MGP] Sudah berjalan. Stop dulu: window.__multiGamePresence.stop()");
        return;
    }

    const platform = /Mac/i.test(navigator.userAgent)
        ? "darwin"
        : /Linux/i.test(navigator.userAgent)
            ? "linux"
            : "win32";

    const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

    function shuffle(list) {
        const copy = list.slice();
        for (let i = copy.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    function getWebpackRequire() {
        try {
            if (window.Vencord?.Webpack?.wreq?.c) return window.Vencord.Webpack.wreq;
        } catch (_) { /* ignore */ }

        if (typeof webpackChunkdiscord_app === "undefined") return null;

        let found = null;
        let best = 0;
        try {
            webpackChunkdiscord_app.push([[Symbol("mgp")], {}, incoming => {
                const count = incoming && incoming.c ? Object.keys(incoming.c).length : 0;
                if (count > best) {
                    best = count;
                    found = incoming;
                }
            }]);
        } catch (_) { /* ignore */ }
        try { webpackChunkdiscord_app.pop(); } catch (_) { /* ignore */ }
        return found;
    }

    function collectExports(req) {
        const values = new Set();
        const modules = req && req.c ? req.c : {};
        for (const key of Object.keys(modules)) {
            let exported;
            try { exported = modules[key] && modules[key].exports; } catch (_) { continue; }
            if (!exported) continue;
            values.add(exported);
            try { if (exported.default) values.add(exported.default); } catch (_) { /* ignore */ }
            if (typeof exported === "object") {
                for (const name of Object.keys(exported)) {
                    try {
                        const value = exported[name];
                        if (value && (typeof value === "object" || typeof value === "function")) values.add(value);
                    } catch (_) { /* ignore */ }
                }
            }
        }
        return [...values].filter(value => value && (typeof value === "object" || typeof value === "function"));
    }

    function findStore(values, displayName) {
        for (const value of values) {
            try {
                if (typeof value.getName === "function" && value.getName() === displayName) return value;
            } catch (_) { /* ignore */ }
            try {
                const proto = Object.getPrototypeOf(value);
                if (proto && proto.constructor && proto.constructor.displayName === displayName) return value;
            } catch (_) { /* ignore */ }
        }
        return null;
    }

    function findDispatcher(values) {
        try {
            const vencord = window.Vencord?.Webpack?.findByProps?.(
                "dispatch", "subscribe", "_actionHandlers"
            );
            if (vencord && typeof vencord.dispatch === "function") return vencord;
        } catch (_) { /* ignore */ }

        for (const value of values) {
            try {
                if (typeof value.dispatch !== "function") continue;
                if (typeof value.subscribe !== "function") continue;
                if (!value._actionHandlers) continue;
                return value;
            } catch (_) { /* ignore */ }
        }
        return null;
    }

    const req = getWebpackRequire();
    if (!req || !req.c) {
        throw new Error("[MGP] Webpack Discord tidak ditemukan. Jalankan di console client desktop.");
    }

    const exportValues = collectExports(req);
    const runStore = findStore(exportValues, "RunningGameStore");
    const dispatcher = findDispatcher(exportValues);
    if (!runStore || !dispatcher) {
        throw new Error("[MGP] RunningGameStore atau Flux Dispatcher tidak ditemukan.");
    }

    const PATCHED = ["getRunningGames", "getGameForPID", "getVisibleGame", "getVisibleRunningGames"];
    const original = new Map();
    for (const key of PATCHED) {
        if (typeof runStore[key] === "function") original.set(key, runStore[key]);
    }
    if (!original.has("getRunningGames") || !original.has("getGameForPID")) {
        throw new Error("[MGP] Metode RunningGameStore yang dibutuhkan tidak ada.");
    }

    let current = null;
    let stopped = false;
    let switching = true;
    let timer = null;
    let abort = null;
    let allGames = [];
    let queue = [];
    let pid = null;
    let api = null;
    let listenerAttached = false;
    let minChangeMs = MIN_CHANGE_MS;
    let maxChangeMs = MAX_CHANGE_MS;
    const used = new Set();
    const IGNORED_REAL_GAMES = [/deepseek[\s_-]*harness/i];

    const slug = name => String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "game";

    function exeOf(name) {
        return `${slug(name)}${platform === "win32" ? ".exe" : ""}`;
    }

    function isIgnoredRealGame(game) {
        if (!game) return false;
        const text = `${game.name || ""} ${game.exeName || ""} ${game.exePath || ""} ${game.processName || ""}`;
        return IGNORED_REAL_GAMES.some(regex => {
            try { return regex.test(text); } catch (_) { return false; }
        });
    }

    function realGames() {
        try {
            const list = original.get("getRunningGames").call(runStore);
            if (!Array.isArray(list)) return [];
            return list.filter(game => game && game.pid !== pid && !isIgnoredRealGame(game));
        } catch (_) {
            return [];
        }
    }

    function buildGame(entry) {
        const executable = entry.exeName || exeOf(entry.name);
        const path = `/synthetic/games/${slug(entry.name)}/${executable}`;
        return {
            id: entry.id,
            name: entry.name,
            pid,
            pidPath: [pid],
            processName: entry.name,
            start: Date.now(),
            exeName: executable,
            exePath: path,
            cmdLine: path,
            executables: [{ os: platform, name: executable, is_launcher: false }],
            windowHandle: 0,
            fullscreenType: 0,
            overlay: false,
            sandboxed: false,
            hidden: false,
            isLauncher: false
        };
    }

    pid = (() => {
        const taken = new Set(realGames().map(game => game.pid));
        let value = 0;
        do {
            value = randomInt(40000, 59999);
        } while (taken.has(value));
        return value;
    })();

    function restore() {
        for (const [key, fn] of original) {
            try { runStore[key] = fn; } catch (_) { /* ignore */ }
        }
    }

    function install() {
        runStore.getRunningGames = function getRunningGamesPatched() {
            const list = realGames();
            if (stopped || !current) return list;
            return list.some(game => game.pid === pid) ? list : list.concat(current);
        };

        runStore.getGameForPID = function getGameForPIDPatched(value) {
            if (!stopped && current && value === pid) return current;
            return original.get("getGameForPID").call(this, value);
        };

        if (original.has("getVisibleGame")) {
            runStore.getVisibleGame = function getVisibleGamePatched() {
                if (!stopped && current && realGames().length === 0) return current;
                return original.get("getVisibleGame").call(this);
            };
        }

        if (original.has("getVisibleRunningGames")) {
            runStore.getVisibleRunningGames = function getVisibleRunningGamesPatched() {
                const base = original.get("getVisibleRunningGames").call(this);
                const list = Array.isArray(base)
                    ? base.filter(game => game && game.pid !== pid && !isIgnoredRealGame(game))
                    : [];
                if (stopped || !current || realGames().length > 0) return list;
                return list.concat(current);
            };
        }
    }

    try {
        install();
    } catch (err) {
        restore();
        throw new Error(`[MGP] Store tidak bisa dipatch: ${err && err.message ? err.message : err}`);
    }

    function dispatch(type, payload) {
        try {
            dispatcher.dispatch({ type, ...payload });
            return true;
        } catch (err) {
            console.warn(`[MGP] dispatch ${type} gagal:`, err && err.message ? err.message : err);
            return false;
        }
    }

    function activityFor(game) {
        const activity = {
            application_id: game.id,
            name: game.name,
            type: 0,
            timestamps: { start: game.start },
            flags: 0
        };
        if (game.iconHash) {
            activity.assets = {
                large_image: `mp:${game.iconHash}`,
                large_text: game.name
            };
        }
        return activity;
    }

    function activate(game) {
        const previous = current;
        if (previous) {
            dispatch("RUNNING_GAMES_CHANGE", { added: [], removed: [previous], games: realGames() });
        }

        current = game;
        dispatch("RUNNING_GAMES_CHANGE", {
            added: [game],
            removed: [],
            games: realGames().concat(game)
        });

        if (realGames().length === 0) {
            dispatch("LOCAL_ACTIVITY_UPDATE", {
                socketId: null,
                pid,
                activity: activityFor(game)
            });
        }

        console.log(`[MGP] Playing: ${game.name} (${game.id})`);
    }

    function refillQueue() {
        if (!allGames.length) return;
        if (used.size >= allGames.length) used.clear();
        queue = shuffle(allGames.filter(game => !used.has(game.id)));
    }

    function scheduleNext() {
        if (stopped || !switching) return;
        clearTimeout(timer);
        const delay = randomInt(minChangeMs, maxChangeMs);
        timer = setTimeout(() => { advance(); }, delay);
        console.log(`[MGP] Game berikutnya ~${(delay / 60000).toFixed(1)} menit.`);
    }

    function advance() {
        if (stopped || !allGames.length) return;
        if (!queue.length) refillQueue();
        const entry = queue.pop();
        if (!entry) return;
        used.add(entry.id);
        activate(buildGame(entry));
        scheduleNext();
    }

    function pauseSwitching() {
        switching = false;
        clearTimeout(timer);
        timer = null;
        console.log("[MGP] Auto-switch dijeda; game saat ini dipertahankan.");
    }

    function resumeSwitching() {
        if (stopped || switching) return;
        switching = true;
        scheduleNext();
        console.log("[MGP] Auto-switch dilanjutkan.");
    }

    function setIntervalMinutes(min, max = min) {
        const first = Number(min);
        const second = max == null ? first : Number(max);
        if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) {
            console.warn("[MGP] Interval tidak valid. Contoh: setIntervalMinutes(8, 15)");
            return;
        }
        minChangeMs = Math.max(1, first) * 60000;
        maxChangeMs = Math.max(minChangeMs, second * 60000);
        console.log(`[MGP] Interval: ${(minChangeMs / 60000).toFixed(1)}–${(maxChangeMs / 60000).toFixed(1)} menit.`);
        if (!stopped && switching) scheduleNext();
    }

    function ignoreRealGame(pattern) {
        try {
            const source = pattern instanceof RegExp ? pattern.source : String(pattern || "");
            if (!source.trim()) throw new Error("pattern kosong");
            const flags = pattern instanceof RegExp
                ? pattern.flags.replace(/[gy]/g, "")
                : "i";
            const regex = new RegExp(source, flags);
            IGNORED_REAL_GAMES.push(regex);
            console.log(`[MGP] Game nyata diabaikan: ${regex}`);
        } catch (err) {
            console.warn("[MGP] Pattern tidak valid:", err && err.message ? err.message : err);
        }
    }

    function stop() {
        if (stopped) return;
        stopped = true;
        switching = false;
        clearTimeout(timer);
        timer = null;
        try { if (abort) abort.abort(); } catch (_) { /* ignore */ }

        const previous = current;
        current = null;
        restore();

        if (previous) {
            dispatch("RUNNING_GAMES_CHANGE", { added: [], removed: [previous], games: realGames() });
            if (realGames().length === 0) {
                dispatch("LOCAL_ACTIVITY_UPDATE", { socketId: null, pid, activity: null });
            }
        }

        if (listenerAttached) {
            window.removeEventListener("pagehide", stop);
            listenerAttached = false;
        }
        if (api && window[LOCK] === api) delete window[LOCK];
        console.log("[MGP] Dihentikan; RunningGameStore dipulihkan.");
    }

    async function loadGames() {
        abort = new AbortController();
        const timeout = setTimeout(() => {
            try { abort.abort(); } catch (_) { /* ignore */ }
        }, 30000);

        try {
            const response = await fetch(DETECTABLE_URL, {
                signal: abort.signal,
                credentials: "omit",
                cache: "default"
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const payload = await response.json();
            if (!Array.isArray(payload)) throw new Error("Format daftar game tidak dikenal.");

            const seen = new Set();
            const games = [];
            for (const item of payload) {
                if (!item || !item.id || !item.name) continue;
                const id = String(item.id);
                if (seen.has(id)) continue;

                const executables = Array.isArray(item.executables) ? item.executables : [];
                const executable = executables.find(entry =>
                    entry && entry.os === platform && entry.name && entry.is_launcher !== true
                );
                if (!executable) continue;

                seen.add(id);
                games.push({
                    id,
                    name: String(item.name),
                    exeName: String(executable.name).split(/[\\/]/).pop().replace(/^>/, ""),
                    iconHash: typeof item.icon_hash === "string" ? item.icon_hash : null
                });
            }

            if (games.length < 50) throw new Error(`Hanya ${games.length} game valid yang ditemukan.`);
            return games;
        } finally {
            clearTimeout(timeout);
        }
    }

    api = {
        version: VERSION,
        stop,
        next: advance,
        pauseSwitching,
        resumeSwitching,
        setIntervalMinutes,
        ignoreRealGame,
        get current() { return current ? current.name : null; },
        get games() { return allGames.length; },
        get remaining() { return allGames.length ? Math.max(0, allGames.length - used.size) : 0; },
        get switching() { return switching && !stopped; }
    };

    window[LOCK] = api;
    window.addEventListener("pagehide", stop, { once: true });
    listenerAttached = true;

    (async () => {
        if (stopped) return;
        console.log(`[MGP] v${VERSION} — mengambil daftar game resmi Discord...`);
        allGames = await loadGames();
        console.log(`[MGP] ${allGames.length} game siap.`);
        if (stopped) return;
        advance();
    })().catch(err => {
        console.error("[MGP] Gagal start:", err && err.message ? err.message : err);
        stop();
    });
})();
