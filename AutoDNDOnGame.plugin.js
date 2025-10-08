/**
 * @name AutoDNDOnGame
 * @description Automatically set your status to Do Not Disturb when you launch a game
 * @version 1.2.0
 * @author Xenon Colt
 * @authorLink https://xenoncolt.live
 * @website https://github.com/xenoncolt/AutoDNDOnGame
 * @source https://raw.githubusercontent.com/xenoncolt/AutoDNDOnGame/main/AutoDNDOnGame.plugin.js
 * @invite vJRe78YmN8
 */

const config = {
    main: "AutoDNDOnGame.plugin.js",
    info: {
        name: "AutoDNDOnGame",
        authors: [
            {
                name: "Xenon Colt",
                authorId: "709210314230726776",
                github_username: "xenoncolt",
                link: "https://xenoncolt.live"
            }
        ],
        version: "1.2.0",
        description: "Automatically set your status to Do Not Disturb when you launch a game",
        github: "https://github.com/xenoncolt/AutoDNDOnGame",
        invite: "vJRe78YmN8",
        github_raw: "https://raw.githubusercontent.com/xenoncolt/AutoDNDOnGame/main/AutoDNDOnGame.plugin.js"
    },
    helpers: ":3",
    changelog: [
        {
            title: "New Features & Improvements",
            type: "added",
            items: [
                "Game list management: whitelist or blacklist games individually",
                "Recent games list integrated into settings with toggle switches",
                "Some improvements"
            ]
        }
    ],
    settingsPanel: [
        {
            type: "radio",
            name: "Change Status To:",
            note: "What status should be set when you launch a game?",
            id: "inGameStatus",
            value: "dnd",
            options: [
                { name: "Do Not Disturb", value: "dnd", color: "#6C0F0F" },
                { name: "Invisible", value: "invisible", color: "#242222" },
                { name: "Idle", value: "idle", color: "#BB9C00" }
            ]
        },
        {
            type: "slider",
            name: "Back to Online Delay:",
            note: "How long should the plugin wait before setting your status back to online after you close a game?",
            id: "revertDelay",
            min: 5,
            max: 120,
            units: "s",
            value: 10,
            markers: [5, 15, 30, 45, 60, 75, 90, 105, 120]
        },
        {
            type: "switch",
            name: "Show Notification",
            note: "Should the plugin show a notification when it changes your status?",
            id: "showToasts",
            value: true
        },
        {
            type: "switch",
            id: "startupOnline",
            name: "Set Online on Startup",
            note: "Change your status to online when Discord starts if you're not already online",
            value: false,
        },
        {
            type: "radio",
            id: "gameListMode",
            name: "Game List Mode",
            note: "Choose whether the selected games should be included (whitelist) or excluded (blacklist)",
            value: "whitelist",
            options: [
                { name: "Only selected games (whitelist)", value: "whitelist" },
                { name: "Exclude selected games (blacklist)", value: "blacklist" }
            ]
        },
        { type: "header", id: "hdr_games", name: "Games" }
    ]
};

let defaultSettings = {
    inGameStatus: "dnd",
    revertDelay: 10,
    showToasts: true,
    startupOnline: false,
    targetGames: [],          // Array of games with {id, name, enabled}
    gameListMode: "whitelist" // whitelist = only these games, blacklist = exclude these games
};

const { Webpack, UI, Logger, Data } = BdApi;

class AutoDNDOnGame {
    constructor() {
        this._config = config;
        this.settings = Object.assign({}, defaultSettings, Data.load(this._config.info.name, "settings"));

        this.hasSetStatus = false;
        this.revertTimeoutId = null;
        this.statusChangeCount = 0;
        this.statusChangeThreshold = 5;
        this.statusChangeResetInterval = null;
        this.boundHandlePresenceChange = this.handlePresenceChange.bind(this);
        this.boundHandleGamesStoreChange = this.handleGamesStoreChange.bind(this);
        this.recentGames = [];

        try {
            let currentVersionInfo = Object.assign({}, { version: this._config.info.version, hasShownChangelog: false }, Data.load(this._config.info.name, "currentVersionInfo"));
            if (this._config.info.version != currentVersionInfo.version) currentVersionInfo.hasShownChangelog = false;
            currentVersionInfo.version = this._config.info.version;
            if (!currentVersionInfo.hasShownChangelog) {
                UI.showChangelogModal({
                    title: "AutoDNDOnGame Changelog",
                    subtitle: this._config.info.version,
                    changes: this._config.changelog
                });
                currentVersionInfo.hasShownChangelog = true;
            }
            Data.save(this._config.info.name, "currentVersionInfo", currentVersionInfo);
        } catch (err) {
            Logger.error(this._config.info.name, err);
        }
    }

    // Helper
    isSameGame(a, b) {
        const getId = g => typeof g === "string" && g.startsWith("id:") ? g.slice(3) : g.id;
        const getName = g => typeof g === "string" && g.startsWith("name:") ? g.slice(5) : g.name;

        const idA = getId(a);
        const idB = getId(b);
        if (idA && idB && idA === idB) return true;

        const nameA = getName(a)?.toLowerCase();
        const nameB = getName(b)?.toLowerCase();
        if (nameA && nameB && nameA === nameB) return true;

        return false;
    }

    start() {
        this.settings = Object.assign({}, defaultSettings, Data.load(this._config.info.name, "settings") || {});

        this.presenceStore = Webpack.getStore?.("PresenceStore");
        this.CurrentUserStore = Webpack.getStore?.("UserStore");
        this.UserSettingsProtoStore = Webpack.getStore?.("UserSettingsProtoStore");

        // RegisteredGamesStore is used only for populating recent games in settings
        this.RegisteredGamesStore = Webpack.getModule(m => m?.getGamesSeen)|| null;
        try {
            this.recentGames = this.RegisteredGamesStore?.getGamesSeen?.() ?? [];
            if (this.RegisteredGamesStore?.addChangeListener) {
                this.RegisteredGamesStore.addChangeListener(this.boundHandleGamesStoreChange);
            }
        } catch (e) {
            Logger.warn(this._config.info.name, "Cannot access RegisteredGamesStore safely:", e);
            this.recentGames = [];
        }

        if (!this.presenceStore || !this.CurrentUserStore || !this.UserSettingsProtoStore) {
            UI.showToast("Presence/User stores not found. Plugin may not work.", { type: "error" });
            return;
        }

        if (this.settings.startupOnline && this.currentStatus() !== "online") {
            this.updateStatus("online");
            if (this.settings.showToasts) UI.showToast("Status changed to online on startup", { type: "success" });
            Logger.info(this._config.info.name, "Changed status to online on startup");
        }

        this.presenceStore.addChangeListener(this.boundHandlePresenceChange);

        this.statusChangeResetInterval = setInterval(() => {
            this.statusChangeCount = 0;
            Logger.info(this._config.info.name, "Status change count reset");
        }, 10 * 60 * 1000);
    }

    stop() {
        if (this.presenceStore) this.presenceStore.removeChangeListener(this.boundHandlePresenceChange);
        if (this.RegisteredGamesStore?.removeChangeListener) {
            try { this.RegisteredGamesStore.removeChangeListener(this.boundHandleGamesStoreChange); } catch (e) {}
        }
        if (this.revertTimeoutId) {
            clearTimeout(this.revertTimeoutId);
            this.revertTimeoutId = null;
        }
        if (this.statusChangeResetInterval) {
            clearInterval(this.statusChangeResetInterval);
            this.statusChangeResetInterval = null;
        }
        if (this.hasSetStatus) {
            this.updateStatus("online");
            this.hasSetStatus = false;
        }
    }

    handleGamesStoreChange() {
        this.recentGames = this.RegisteredGamesStore?.getGamesSeen?.() ?? [];
    }

    getSettingsPanel() {
        this.settings = Object.assign({}, defaultSettings, Data.load(this._config.info.name, "settings") || {});

        for (const s of this._config.settingsPanel) {
            if (this.settings[s.id] !== undefined) s.value = this.settings[s.id];
        }

        const gamesList = (this.RegisteredGamesStore?.getGamesSeen?.() ?? this.recentGames ?? []).filter(Boolean);

        // Merge recent games with saved target games
        const combinedGames = [];
        for (const g of gamesList) {
            const gid = g.id ?? g.application_id ?? g.applicationId ?? null;
            const gname = g.name ?? g.title ?? String(g);
            combinedGames.push({ id: gid ? String(gid) : null, name: gname });
        }
        for (const tg of this.settings.targetGames) {
            if (!combinedGames.some(c => this.isSameGame(c, tg))) {
                combinedGames.push(tg);
            }
        }

        const gameSwitches = combinedGames.map((game, idx) => {
            const existing = this.settings.targetGames.find(tg => this.isSameGame(tg, game));
            const isEnabled = existing ? existing.enabled !== false : false;
            return {
                type: "switch",
                id: `game_${idx}`,
                name: game.name || `AppID: ${game.id}`,
                value: isEnabled
            };
        });

        return UI.buildSettingsPanel({
            settings: [
                ...this._config.settingsPanel,
                ...gameSwitches
            ],
            onChange: (category, id, value) => {
                if (id.startsWith("game_")) {
                    const index = parseInt(id.split("_")[1], 10);
                    const game = combinedGames[index];

                    let existing = this.settings.targetGames.find(tg => this.isSameGame(tg, game));
                    if (value) {
                        if (existing) existing.enabled = true;
                        else this.settings.targetGames.push({ ...game, enabled: true });
                    } else if (existing) {
                        existing.enabled = false;
                    }
                    this.saveAndUpdate();
                    return;
                }
                this.settings[id] = value;
                this.saveAndUpdate();
            }
        });
    }

    saveAndUpdate() {
        Data.save(this._config.info.name, "settings", this.settings);
    }

    // Called when the presence changes.
    handlePresenceChange() {
        const currentUser = this.CurrentUserStore.getCurrentUser();
        if (!currentUser) return;
        const activities = this.presenceStore.getActivities(currentUser.id) || [];

        const gameActivities = activities.filter(act => act?.type === 0 && (act.name || act.application_id || act.applicationId));

        const mode = this.settings.gameListMode || "whitelist";
        let shouldTrigger = false;

        for (const act of gameActivities) {
            const appId = act.application_id ?? act.applicationId ?? act.id ?? null;
            const gname = act.name ? String(act.name).trim() : "";
            if (!gname && !appId) continue;

            const newEntry = {};
            if (appId) newEntry.id = String(appId);
            if (gname) newEntry.name = gname;

            // If game not yet known, add to list as disabled by default
            let alreadyKnown = this.settings.targetGames.some(g => this.isSameGame(g, newEntry));
            if (!alreadyKnown) {
                this.settings.targetGames.push({ ...newEntry, enabled: false });
                this.saveAndUpdate();
            }

            // Check against enabled games
            let exists = this.settings.targetGames.some(g => g.enabled !== false && this.isSameGame(g, newEntry));
            if ((mode === "whitelist" && exists) || (mode === "blacklist" && !exists)) {
                shouldTrigger = true;
                break;
            }
        }

        if (shouldTrigger) {
            if (!this.hasSetStatus && this.currentStatus() !== this.settings.inGameStatus) {
                this.updateStatus(this.settings.inGameStatus);
                this.hasSetStatus = true;
                if (this.settings.showToasts) UI.showToast(`Game detected → status ${this.settings.inGameStatus}`, { type: "danger" });
            }
            if (this.revertTimeoutId) {
                clearTimeout(this.revertTimeoutId);
                this.revertTimeoutId = null;
            }
        } else {
            // Games running but not in target list → revert online
            if (this.hasSetStatus) {
                if (this.revertTimeoutId) clearTimeout(this.revertTimeoutId);
                this.revertTimeoutId = setTimeout(() => {
                    this.updateStatus("online");
                    this.hasSetStatus = false;
                    if (this.settings.showToasts) UI.showToast("No target games detected → reverting status to online.", { type: "success" });
                }, (this.settings.revertDelay || 10) * 1000);
            }
        }
    }

    currentStatus() {
        return this.UserSettingsProtoStore.settings.status.status.value;
    }

    // Update user status
    updateStatus(toStatus) {
        if (this.statusChangeCount >= this.statusChangeThreshold) {
            Logger.info(this._config.info.name, "Status change limit reached. Skipping status change");
            return;
        }

        const UserSettingsProtoUtils = Webpack.getModule(m => m.ProtoClass && m.ProtoClass.typeName.endsWith(".PreloadedUserSettings"), { first: true, searchExports: true });

        UserSettingsProtoUtils.updateAsync("status", statusSetting => {
            statusSetting.status.value = toStatus;
        }, 0);
    }
}

module.exports = AutoDNDOnGame;
/*@end@*/