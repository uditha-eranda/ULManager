(() => {
  const db = new window.ULDatabase();

  const state = {
    users: [],
    activeUser: null,
    activeUserData: null,
    editingSettingField: null,
    confirmCallback: null,
  };

  // ==================== DATE & CURRENCY HELPERS ====================
  function toDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseDateKey(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addOneMonth(dateKey) {
    const dt = parseDateKey(dateKey);
    const targetMonth = dt.getMonth() + 1;
    const origDay = dt.getDate();
    dt.setMonth(targetMonth);
    if (dt.getDate() !== origDay) {
      dt.setDate(0);
    }
    return toDateKey(dt);
  }

  function addDays(dateKey, days) {
    const dt = parseDateKey(dateKey);
    dt.setDate(dt.getDate() + days);
    return toDateKey(dt);
  }

  function getNextResetDate(resetDate, user) {
    const freq = (user && user.resetFrequency) || "monthly";
    if (freq === "weekly") return addDays(resetDate, 7);
    if (freq === "biweekly") return addDays(resetDate, 14);
    if (freq === "custom") {
      const days = Math.max(1, parseInt(user.resetDays, 10) || 30);
      return addDays(resetDate, days);
    }
    return addOneMonth(resetDate);
  }

  function formatResetFrequency(user) {
    const freq = (user && user.resetFrequency) || "monthly";
    if (freq === "weekly") return "Weekly (7 days)";
    if (freq === "biweekly") return "Bi-weekly (14 days)";
    if (freq === "custom") {
      const days = Math.max(1, parseInt(user.resetDays, 10) || 30);
      return `Every ${days} ${days === 1 ? "day" : "days"}`;
    }
    return "Monthly";
  }

  function daysBetween(startKey, endKey) {
    const msPerDay = 86400000;
    const s = parseDateKey(startKey);
    const e = parseDateKey(endKey);
    return Math.round((e - s) / msPerDay);
  }

  function formatDisplayDate(dateKey) {
    const dt = parseDateKey(dateKey);
    return dt.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatCurrency(amount) {
    const num = Number(amount) || 0;
    const sign = num < 0 ? "-" : "";
    const abs = Math.abs(num).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sign}Rs. ${abs}`;
  }

  function formatTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function getSpendColor(pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    let hue;
    if (clamped <= 50) {
      hue = 145 - (clamped / 50) * 100; // 145 (green) -> 45 (yellow)
    } else {
      hue = 45 - ((clamped - 50) / 50) * 45; // 45 (yellow) -> 0 (red)
    }
    const sat = clamped <= 50 ? 74 + (clamped / 50) * 18 : 92 - ((clamped - 50) / 50) * 8;
    const light = clamped <= 50 ? 44 + (clamped / 50) * 6 : 50 + ((clamped - 50) / 50) * 6;
    return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
  }

  function formatCompactAmount(amount) {
    const n = Number(amount) || 0;
    if (n >= 1000) {
      return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    }
    return `${Math.round(n)}`;
  }

  function formatShortDate(dateKey) {
    const dt = parseDateKey(dateKey);
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ==================== FINANCIAL CALCULATIONS ====================
  function sumItems(items = []) {
    return items.reduce((acc, item) => acc + (Number(item.price) || 0), 0);
  }

  function computeAccountMetrics(user, userData, todayKey = toDateKey()) {
    const resetDate = user.resetDate || todayKey;
    const nextResetDate = getNextResetDate(resetDate, user);
    const daysToReset = Math.max(1, daysBetween(todayKey, nextResetDate));

    const itemsByDate = userData.itemsByDate || {};
    let totalSpentFromReset = 0;

    for (const [dateKey, items] of Object.entries(itemsByDate)) {
      if (dateKey >= resetDate) {
        totalSpentFromReset += sumItems(items);
      }
    }

    const todayItems = itemsByDate[todayKey] || [];
    const todayCost = sumItems(todayItems);

    const totalRemaining = user.limit - totalSpentFromReset;
    const remainingBeforeToday = user.limit - (totalSpentFromReset - todayCost);
    const dailySuggestedTarget = remainingBeforeToday / daysToReset;
    const suggestedRemainingToday = dailySuggestedTarget - todayCost;

    return {
      todayKey,
      resetDate,
      nextResetDate,
      daysToReset,
      totalSpentFromReset,
      totalRemaining,
      todayItems,
      todayCost,
      dailySuggestedTarget,
      suggestedRemainingToday,
    };
  }

  function computePastActivity(user, userData) {
    const resetDate = user.resetDate || toDateKey();
    const nextResetDate = getNextResetDate(resetDate, user);
    const itemsByDate = userData.itemsByDate || {};

    const datesAsc = Object.keys(itemsByDate)
      .filter((d) => d >= resetDate && itemsByDate[d].length > 0)
      .sort((a, b) => a.localeCompare(b));

    let runningSpent = 0;
    const records = datesAsc.map((dateKey) => {
      const items = itemsByDate[dateKey];
      const dayCost = sumItems(items);
      const remainingBeforeDay = user.limit - runningSpent;
      const daysLeftOnDay = Math.max(1, daysBetween(dateKey, nextResetDate));
      const suggestedForDay = remainingBeforeDay / daysLeftOnDay;
      const exceeded = dayCost > suggestedForDay;

      runningSpent += dayCost;

      return {
        dateKey,
        dayCost,
        suggestedForDay,
        exceeded,
        items,
      };
    });

    // Latest are at up
    return records.reverse();
  }

  // ==================== UI NAVIGATION & MODALS ====================
  function showScreen(screenId) {
    document.querySelectorAll(".screen").forEach((el) => {
      el.classList.toggle("screen-active", el.id === screenId);
    });
  }

  function openModal(modalId) {
    const backdrop = document.getElementById("modal-backdrop");
    document.querySelectorAll(".modal-sheet").forEach((m) => m.classList.remove("active"));
    const target = document.getElementById(modalId);
    if (target) {
      target.classList.add("active");
      backdrop.classList.add("open");
      backdrop.setAttribute("aria-hidden", "false");
    }
  }

  function closeModal() {
    const backdrop = document.getElementById("modal-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    document.querySelectorAll(".modal-sheet").forEach((m) => m.classList.remove("active"));
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function askConfirm(title, message, onConfirm) {
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-message").textContent = message;
    state.confirmCallback = onConfirm;
    openModal("modal-confirm");
  }

  // ==================== RENDERING ====================
  function renderHome() {
    const listEl = document.getElementById("accounts-list");
    const countPill = document.getElementById("account-count-pill");
    const count = state.users.length;
    countPill.textContent = `${count} ${count === 1 ? "account" : "accounts"}`;

    if (count === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <p class="empty-state-title">No accounts yet</p>
          <p class="empty-state-sub">Tap <strong>+ Add Account</strong> below to create your first profile and start tracking your monthly allowance.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = state.users
      .map((u) => {
        const initial = (u.username || "U").charAt(0).toUpperCase();
        return `
          <button class="account-card" type="button" data-user-id="${escapeHtml(u.id)}">
            <div class="account-card-avatar">${escapeHtml(initial)}</div>
            <div class="account-card-info">
              <div class="account-card-name">${escapeHtml(u.username)}</div>
              <div class="account-card-meta">${escapeHtml(u.email)} &bull; ${formatCurrency(u.limit)} (${escapeHtml(formatResetFrequency(u))})</div>
            </div>
            <svg class="account-card-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
        `;
      })
      .join("");
  }

  function renderAccountDashboard() {
    const user = state.activeUser;
    const data = state.activeUserData;
    if (!user || !data) return;

    const metrics = computeAccountMetrics(user, data);

    document.getElementById("account-avatar").textContent = user.username.charAt(0).toUpperCase();
    document.getElementById("account-greeting").textContent = `Hi ${user.username} !`;

    document.getElementById("metric-date").textContent = formatDisplayDate(metrics.todayKey);
    document.getElementById("metric-days-left").textContent =
      `${metrics.daysToReset} ${metrics.daysToReset === 1 ? "day" : "days"} to reset`;

    const dailyEl = document.getElementById("metric-daily-remaining");
    const dailyCard = document.getElementById("metric-daily-card");
    dailyEl.textContent = formatCurrency(metrics.suggestedRemainingToday);
    document.getElementById("metric-today-cost-hero").textContent = formatCurrency(metrics.todayCost);
    document.getElementById("metric-daily-hint").textContent =
      `Target: ${formatCurrency(metrics.dailySuggestedTarget)}`;
    dailyCard.classList.toggle("is-exceeded", metrics.suggestedRemainingToday < 0);

    // Circular graph visualizes today's cost percentage against today's suggested target
    let rawDailyPct = 0;
    if (metrics.dailySuggestedTarget > 0) {
      rawDailyPct = (metrics.todayCost / metrics.dailySuggestedTarget) * 100;
    } else if (metrics.todayCost > 0) {
      rawDailyPct = 100;
    }
    const clampedPct = Math.max(0, Math.min(100, rawDailyPct));
    const circumference = 226.2;
    const offset = circumference - (clampedPct / 100) * circumference;

    const ringCircle = document.getElementById("cost-ring-circle");
    ringCircle.style.strokeDashoffset = offset.toFixed(2);

    // Smoothly transition ring color from green (0%) -> yellow (50%) -> red (100%+)
    const colorPct = metrics.suggestedRemainingToday < 0 ? 100 : clampedPct;
    ringCircle.style.stroke = getSpendColor(colorPct);

    document.getElementById("cost-ring-percent").textContent = `${Math.round(rawDailyPct)}%`;

    // Secondary cycle totals
    document.getElementById("metric-total-remaining").textContent = formatCurrency(metrics.totalRemaining);
    document.getElementById("metric-total-cost").textContent = formatCurrency(metrics.totalSpentFromReset);
    document.getElementById("metric-allowance-chip").textContent = `/ ${formatCurrency(user.limit)}`;

    document.getElementById("today-total-cost").textContent = formatCurrency(metrics.todayCost);

    const itemsListEl = document.getElementById("today-items-list");
    if (metrics.todayItems.length === 0) {
      itemsListEl.innerHTML = `
        <div class="empty-state" style="padding: 22px 16px;">
          <p class="empty-state-title">No items added today</p>
          <p class="empty-state-sub">Click <strong>+ Add Items</strong> to log an expense.</p>
        </div>
      `;
    } else {
      // Latest added item is already at index 0
      itemsListEl.innerHTML = metrics.todayItems
        .map(
          (item) => `
          <div class="item-row">
            <div class="item-row-left">
              <span class="item-name">${escapeHtml(item.name)}</span>
              <span class="item-time">${formatTime(item.createdAt)}</span>
            </div>
            <div class="item-row-right">
              <span class="item-price tabular">${formatCurrency(item.price)}</span>
              <button class="item-delete-btn" type="button" data-delete-item="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.name)}" title="Remove item">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                </svg>
              </button>
            </div>
          </div>
        `
        )
        .join("");
    }
  }

  function renderFrequentItemsList() {
    const data = state.activeUserData;
    const listEl = document.getElementById("frequent-items-list");
    const saved = (data && data.savedItems) || [];

    if (saved.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state" style="padding: 20px;">
          <p class="empty-state-sub">No items in your list yet. Click <strong>+ Add More Items</strong> below to add one.</p>
        </div>
      `;
      return;
    }

    if (saved.length > 4) {
      listEl.innerHTML = `
        <div class="frequent-dropdown-box">
          <div class="frequent-dropdown-row">
            <select id="select-frequent-dropdown" aria-label="Pick a frequent item">
              ${saved
                .map(
                  (item) =>
                    `<option value="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}" data-price="${item.price}">${escapeHtml(item.name)} — Rs. ${Number(item.price).toLocaleString()} /=</option>`
                )
                .join("")}
            </select>
            <button class="item-delete-btn" type="button" id="btn-delete-dropdown-item" aria-label="Remove selected item" title="Remove selected item from list">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              </svg>
            </button>
          </div>
          <button class="btn btn-secondary btn-block" type="button" id="btn-add-dropdown-item">
            Add Selected Item
          </button>
        </div>
      `;
      return;
    }

    listEl.innerHTML = saved
      .map(
        (item) => `
        <div class="pick-item-row">
          <button class="pick-item-btn" type="button" data-pick-id="${escapeHtml(item.id)}" data-pick-name="${escapeHtml(item.name)}" data-pick-price="${item.price}">
            <span class="pick-item-name">${escapeHtml(item.name)}</span>
            <span class="pick-item-price tabular">Rs. ${Number(item.price).toLocaleString()} /=</span>
          </button>
          <button class="item-delete-btn" type="button" data-delete-saved="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.name)}" title="Remove from list">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
            </svg>
          </button>
        </div>
      `
      )
      .join("");
  }

  function setAddItemView(mode) {
    const listView = document.getElementById("frequent-items-view");
    const formView = document.getElementById("form-new-item");
    const titleEl = document.getElementById("new-item-title");

    if (mode === "form") {
      listView.classList.add("hidden");
      formView.classList.remove("hidden");
      titleEl.textContent = "Add New Item";
    } else {
      formView.classList.add("hidden");
      listView.classList.remove("hidden");
      titleEl.textContent = "Pick your Items";
    }
  }

  function renderPastActivity() {
    const user = state.activeUser;
    const data = state.activeUserData;
    if (!user || !data) return;

    const records = computePastActivity(user, data);
    const listEl = document.getElementById("past-activity-list");
    const chartCard = document.getElementById("past-bar-chart-card");
    const chartEl = document.getElementById("past-bar-chart");

    if (records.length === 0) {
      chartCard.classList.add("hidden");
      chartEl.innerHTML = "";
      listEl.innerHTML = `
        <div class="empty-state">
          <p class="empty-state-title">No activity recorded yet</p>
          <p class="empty-state-sub">Daily totals from your reset date (${formatDisplayDate(user.resetDate)}) will appear here.</p>
        </div>
      `;
      return;
    }

    // Render daily expenses bar graph chronologically (oldest -> newest)
    chartCard.classList.remove("hidden");
    const chronoRecords = [...records].reverse();
    const maxDayCost = Math.max(1, ...chronoRecords.map((r) => r.dayCost));
    document.getElementById("past-bar-chart-sub").textContent =
      `Peak: ${formatCurrency(maxDayCost)}`;

    chartEl.innerHTML = chronoRecords
      .map((rec) => {
        const heightPct = Math.max(6, (rec.dayCost / maxDayCost) * 100);
        const targetPct = rec.exceeded
          ? 100
          : rec.suggestedForDay > 0
            ? (rec.dayCost / rec.suggestedForDay) * 100
            : 0;
        const barColor = getSpendColor(targetPct);
        const tooltip = `${formatDisplayDate(rec.dateKey)}: ${formatCurrency(rec.dayCost)} (Target: ${formatCurrency(rec.suggestedForDay)})`;

        return `
          <div class="bar-col" title="${escapeHtml(tooltip)}">
            <span class="bar-val tabular">${formatCompactAmount(rec.dayCost)}</span>
            <div class="bar-track">
              <div class="bar-fill" style="height: ${heightPct.toFixed(1)}%; background: ${barColor};"></div>
            </div>
            <span class="bar-date">${formatShortDate(rec.dateKey)}</span>
          </div>
        `;
      })
      .join("");

    listEl.innerHTML = records
      .map((rec) => {
        const dotClass = rec.exceeded ? "dot-red" : "dot-green";
        const statusLabel = rec.exceeded ? "Exceeded suggested" : "Within suggested";
        const latestTime = rec.items[0] && rec.items[0].createdAt ? ` &bull; Last at ${formatTime(rec.items[0].createdAt)}` : "";
        const itemsHtml = rec.items
          .map(
            (it) => `
            <div class="past-detail-item">
              <div class="past-detail-left">
                <span class="past-detail-name">${escapeHtml(it.name)}</span>
                ${it.createdAt ? `<span class="past-detail-time">${formatTime(it.createdAt)}</span>` : ""}
              </div>
              <span class="tabular past-detail-price">${formatCurrency(it.price)}</span>
            </div>
          `
          )
          .join("");

        return `
          <div class="past-card">
            <button class="past-row" type="button" data-toggle-past>
              <div class="past-date-col">
                <span class="past-date">${formatDisplayDate(rec.dateKey)}</span>
                <span class="past-sub">${rec.items.length} ${rec.items.length === 1 ? "item" : "items"} &bull; ${statusLabel}${latestTime}</span>
              </div>
              <div class="past-right-col">
                <span class="past-cost tabular">${formatCurrency(rec.dayCost)}</span>
                <span class="status-dot ${dotClass}" title="${statusLabel}"></span>
              </div>
            </button>
            <div class="past-details">
              ${itemsHtml}
            </div>
          </div>
        `;
      })
      .join("");
  }

  // ==================== ACTIONS ====================
  async function openAccount(userId) {
    const user = await db.getUser(userId);
    if (!user) return;
    state.activeUser = user;
    state.activeUserData = await db.getUserData(userId);
    renderAccountDashboard();
    showScreen("screen-account");
  }

  async function refreshUsersAndHome() {
    state.users = await db.getAllUsers();
    renderHome();
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ulmanager_theme", theme);
    const label = document.getElementById("theme-toggle-label");
    if (label) {
      label.textContent = theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode";
    }
  }

  // ==================== EVENT LISTENERS ====================
  function bindEvents() {
    // Home -> Add User
    document.getElementById("btn-go-add-user").addEventListener("click", () => {
      document.getElementById("form-add-user").reset();
      document.getElementById("group-custom-days").classList.add("hidden");
      showScreen("screen-add-user");
    });

    document.getElementById("input-reset-frequency").addEventListener("change", (e) => {
      document.getElementById("group-custom-days").classList.toggle("hidden", e.target.value !== "custom");
    });

    // Home -> Options
    document.getElementById("btn-home-options").addEventListener("click", () => {
      openModal("modal-options");
    });

    // Home -> Select Account
    document.getElementById("accounts-list").addEventListener("click", (e) => {
      const card = e.target.closest("[data-user-id]");
      if (card) {
        openAccount(card.dataset.userId);
      }
    });

    // Add User -> Back
    document.getElementById("btn-add-user-back").addEventListener("click", () => showScreen("screen-home"));
    document.getElementById("btn-add-user-cancel").addEventListener("click", () => showScreen("screen-home"));

    // Add User -> Submit
    document.getElementById("form-add-user").addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("input-username").value.trim();
      const email = document.getElementById("input-email").value.trim();
      const limit = parseFloat(document.getElementById("input-limit").value);
      const resetFrequency = document.getElementById("input-reset-frequency").value;
      const resetDays = parseInt(document.getElementById("input-reset-days").value, 10);

      if (!username) {
        showToast("Please enter a username.");
        return;
      }
      if (!email || !email.includes("@")) {
        showToast("Please enter a valid email address.");
        return;
      }
      if (!Number.isFinite(limit) || limit <= 0) {
        showToast("Allowance limit must be greater than 0.");
        return;
      }
      if (resetFrequency === "custom" && (!Number.isFinite(resetDays) || resetDays < 1)) {
        showToast("Custom reset interval must be at least 1 day.");
        return;
      }

      const newUser = await db.createUser({
        username,
        email,
        limit,
        resetDate: toDateKey(),
        resetFrequency,
        resetDays: resetFrequency === "custom" ? resetDays : 30,
      });

      await refreshUsersAndHome();
      showToast(`Account "${newUser.username}" created!`);
      await openAccount(newUser.id);
    });

    // Account -> Home
    document.getElementById("btn-account-home").addEventListener("click", async () => {
      await refreshUsersAndHome();
      showScreen("screen-home");
    });

    // Account -> Settings
    document.getElementById("btn-account-settings").addEventListener("click", () => {
      const u = state.activeUser;
      if (!u) return;
      document.getElementById("settings-account-meta").innerHTML = `
        <strong>${escapeHtml(u.username)}</strong><br />
        ${escapeHtml(u.email)} &bull; Limit: ${formatCurrency(u.limit)}<br />
        Frequency: ${escapeHtml(formatResetFrequency(u))} &bull; Reset: ${formatDisplayDate(u.resetDate)}
      `;
      openModal("modal-settings");
    });

    // Account -> + Add Items (Show only frequent item list first)
    document.getElementById("btn-open-add-items").addEventListener("click", () => {
      renderFrequentItemsList();
      setAddItemView("list");
      openModal("modal-new-item");
    });

    // Account -> Delete item
    document.getElementById("today-items-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-delete-item]");
      if (!btn || !state.activeUser) return;
      const itemId = btn.dataset.deleteItem;
      state.activeUserData = await db.deleteExpenseItem(state.activeUser.id, toDateKey(), itemId);
      renderAccountDashboard();
      showToast("Item removed.");
    });

    // Account -> Past Activity
    document.getElementById("btn-past-activity").addEventListener("click", () => {
      renderPastActivity();
      showScreen("screen-past-activity");
    });

    // Past Activity -> Back & Expand
    document.getElementById("btn-past-back").addEventListener("click", () => showScreen("screen-account"));
    document.getElementById("btn-past-back-bottom").addEventListener("click", () => showScreen("screen-account"));

    document.getElementById("past-activity-list").addEventListener("click", (e) => {
      const row = e.target.closest("[data-toggle-past]");
      if (row) {
        row.closest(".past-card").classList.toggle("expanded");
      }
    });

    // Frequent Items List / Dropdown -> Quick Add or Remove Item
    document.getElementById("frequent-items-list").addEventListener("click", async (e) => {
      const delDropdownBtn = e.target.closest("#btn-delete-dropdown-item");
      if (delDropdownBtn && state.activeUser) {
        const select = document.getElementById("select-frequent-dropdown");
        if (!select || !select.value) return;
        state.activeUserData = await db.deleteSavedItem(state.activeUser.id, select.value);
        renderFrequentItemsList();
        showToast("Item removed from list.");
        return;
      }

      const addDropdownBtn = e.target.closest("#btn-add-dropdown-item");
      if (addDropdownBtn && state.activeUser) {
        const select = document.getElementById("select-frequent-dropdown");
        if (!select || !select.value) return;
        const opt = select.options[select.selectedIndex];
        const name = opt.dataset.name;
        const price = parseFloat(opt.dataset.price);
        state.activeUserData = await db.addExpenseItem(state.activeUser.id, toDateKey(), {
          name,
          price,
          saveToCatalog: false,
          savedItemId: select.value,
        });
        renderAccountDashboard();
        closeModal();
        showToast(`Added ${name} (${formatCurrency(price)})`);
        return;
      }

      const delBtn = e.target.closest("[data-delete-saved]");
      if (delBtn && state.activeUser) {
        const savedId = delBtn.dataset.deleteSaved;
        state.activeUserData = await db.deleteSavedItem(state.activeUser.id, savedId);
        renderFrequentItemsList();
        showToast("Item removed from list.");
        return;
      }

      const btn = e.target.closest("[data-pick-name]");
      if (!btn || !state.activeUser) return;
      const name = btn.dataset.pickName;
      const price = parseFloat(btn.dataset.pickPrice);
      const savedItemId = btn.dataset.pickId || null;
      state.activeUserData = await db.addExpenseItem(state.activeUser.id, toDateKey(), {
        name,
        price,
        saveToCatalog: false,
        savedItemId,
      });
      renderAccountDashboard();
      closeModal();
      showToast(`Added ${name} (${formatCurrency(price)})`);
    });

    // + Add More Items -> Show new item form
    document.getElementById("btn-show-new-item").addEventListener("click", () => {
      document.getElementById("form-new-item").reset();
      setAddItemView("form");
      setTimeout(() => document.getElementById("input-item-name").focus(), 100);
    });

    // Back to Item List
    document.getElementById("btn-back-to-frequent").addEventListener("click", () => {
      renderFrequentItemsList();
      setAddItemView("list");
    });

    async function handleAddNewItem(keepOpen) {
      const nameEl = document.getElementById("input-item-name");
      const priceEl = document.getElementById("input-item-price");
      const name = nameEl.value.trim();
      const price = parseFloat(priceEl.value);

      if (!name) {
        showToast("Please enter an item name.");
        return;
      }
      if (!Number.isFinite(price) || price <= 0) {
        showToast("Please enter a valid price.");
        return;
      }

      state.activeUserData = await db.addExpenseItem(state.activeUser.id, toDateKey(), {
        name,
        price,
        saveToCatalog: true,
      });

      renderAccountDashboard();
      renderFrequentItemsList();
      showToast(`Added ${name} (${formatCurrency(price)})`);

      if (keepOpen) {
        document.getElementById("form-new-item").reset();
        nameEl.focus();
      } else {
        closeModal();
      }
    }

    document.getElementById("form-new-item").addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleAddNewItem(false);
    });

    document.getElementById("btn-add-more-item").addEventListener("click", async () => {
      await handleAddNewItem(true);
    });

    // Settings Menu -> Field Edit
    document.getElementById("select-edit-frequency").addEventListener("change", (e) => {
      document.getElementById("edit-custom-days-group").classList.toggle("hidden", e.target.value !== "custom");
    });

    document.querySelectorAll("[data-setting-field]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const field = btn.dataset.settingField;
        const user = state.activeUser;
        if (!user) return;
        state.editingSettingField = field;

        const titleEl = document.getElementById("edit-setting-title");
        const labelEl = document.getElementById("label-edit-setting");
        const inputEl = document.getElementById("input-edit-setting");
        const textGroup = document.getElementById("edit-setting-text-group");
        const freqGroup = document.getElementById("edit-setting-frequency-group");

        textGroup.classList.remove("hidden");
        freqGroup.classList.add("hidden");

        if (field === "username") {
          titleEl.textContent = "Change User Name";
          labelEl.textContent = "Enter new User name";
          inputEl.type = "text";
          inputEl.removeAttribute("step");
          inputEl.value = user.username;
        } else if (field === "email") {
          titleEl.textContent = "Change Email";
          labelEl.textContent = "Enter new Email";
          inputEl.type = "email";
          inputEl.removeAttribute("step");
          inputEl.value = user.email;
        } else if (field === "limit") {
          titleEl.textContent = "Change Allowance Limit";
          labelEl.textContent = "Enter new Allowance Limit (Rs.)";
          inputEl.type = "number";
          inputEl.step = "0.01";
          inputEl.value = user.limit;
        } else if (field === "resetFrequency") {
          titleEl.textContent = "Change Reset Frequency";
          textGroup.classList.add("hidden");
          freqGroup.classList.remove("hidden");
          const freqSelect = document.getElementById("select-edit-frequency");
          const customInput = document.getElementById("input-edit-reset-days");
          const currentFreq = user.resetFrequency || "monthly";
          freqSelect.value = currentFreq;
          customInput.value = user.resetDays || 30;
          document.getElementById("edit-custom-days-group").classList.toggle("hidden", currentFreq !== "custom");
        }

        openModal("modal-edit-setting");
        if (field !== "resetFrequency") {
          setTimeout(() => inputEl.focus(), 120);
        }
      });
    });

    document.getElementById("btn-edit-setting-back").addEventListener("click", () => {
      openModal("modal-settings");
    });

    document.getElementById("form-edit-setting").addEventListener("submit", async (e) => {
      e.preventDefault();
      const field = state.editingSettingField;
      const val = document.getElementById("input-edit-setting").value.trim();
      if (!field || !state.activeUser) return;

      const patch = {};
      if (field === "username") {
        if (!val) return showToast("Username cannot be empty.");
        patch.username = val;
      } else if (field === "email") {
        if (!val || !val.includes("@")) return showToast("Please enter a valid email.");
        patch.email = val;
      } else if (field === "limit") {
        const num = parseFloat(val);
        if (!Number.isFinite(num) || num <= 0) return showToast("Allowance must be greater than 0.");
        patch.limit = num;
      } else if (field === "resetFrequency") {
        const freq = document.getElementById("select-edit-frequency").value;
        const days = parseInt(document.getElementById("input-edit-reset-days").value, 10);
        if (freq === "custom" && (!Number.isFinite(days) || days < 1)) {
          return showToast("Custom reset interval must be at least 1 day.");
        }
        patch.resetFrequency = freq;
        if (freq === "custom") {
          patch.resetDays = days;
        }
      }

      state.activeUser = await db.updateUser(state.activeUser.id, patch);
      await refreshUsersAndHome();
      renderAccountDashboard();
      closeModal();
      showToast("Account updated.");
    });

    // Settings -> Reset Account
    document.getElementById("btn-reset-account").addEventListener("click", () => {
      if (!state.activeUser) return;
      askConfirm(
        "Reset Account",
        `Reset ${state.activeUser.username}'s cycle from today? All logged expenses in this cycle will be cleared.`,
        async () => {
          state.activeUserData = await db.resetAccount(state.activeUser.id, toDateKey());
          state.activeUser = await db.getUser(state.activeUser.id);
          renderAccountDashboard();
          closeModal();
          showToast("Account reset for a new cycle.");
        }
      );
    });

    // Options Menu actions
    document.getElementById("btn-toggle-theme").addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "light";
      applyTheme(current === "dark" ? "light" : "dark");
    });

    document.getElementById("btn-export-data").addEventListener("click", async () => {
      const payload = await db.exportAll();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ul-manager-backup-${toDateKey()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      closeModal();
      showToast("Database exported.");
    });

    document.getElementById("btn-load-demo").addEventListener("click", async () => {
      const today = new Date();
      const threeDaysAgo = new Date(today);
      threeDaysAgo.setDate(today.getDate() - 3);
      const twoDaysAgo = new Date(today);
      twoDaysAgo.setDate(today.getDate() - 2);
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);

      const demoUser = await db.createUser({
        username: "Alex Perera",
        email: "alex@example.com",
        limit: 30000,
        resetDate: toDateKey(threeDaysAgo),
      });

      await db.addExpenseItem(demoUser.id, toDateKey(threeDaysAgo), { name: "Groceries", price: 1450 });
      await db.addExpenseItem(demoUser.id, toDateKey(twoDaysAgo), { name: "Lunch", price: 650 });
      await db.addExpenseItem(demoUser.id, toDateKey(yesterday), { name: "Coffee", price: 320 });
      await db.addExpenseItem(demoUser.id, toDateKey(today), { name: "Bus Fare", price: 150 });

      await refreshUsersAndHome();
      closeModal();
      showToast("Demo account created!");
    });

    // Confirm modal actions
    document.getElementById("btn-confirm-cancel").addEventListener("click", closeModal);
    document.getElementById("btn-confirm-ok").addEventListener("click", async () => {
      if (typeof state.confirmCallback === "function") {
        const cb = state.confirmCallback;
        state.confirmCallback = null;
        await cb();
      }
    });

    // Close modal buttons & backdrop click
    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", closeModal);
    });
    document.getElementById("modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "modal-backdrop") {
        closeModal();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }

  // ==================== INIT ====================
  async function init() {
    const savedTheme = localStorage.getItem("ulmanager_theme") || "light";
    applyTheme(savedTheme);

    await db.init();
    bindEvents();
    await refreshUsersAndHome();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
