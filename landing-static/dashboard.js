const loginPanel = document.getElementById("loginPanel");
const dashboardPanel = document.getElementById("dashboardPanel");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const refreshButton = document.getElementById("refreshButton");
const statsGrid = document.getElementById("statsGrid");
const subscriptionBreakdown = document.getElementById("subscriptionBreakdown");
const eventFeed = document.getElementById("eventFeed");
const usersTableBody = document.getElementById("usersTableBody");
const researchForm = document.getElementById("researchForm");
const researchFormStatus = document.getElementById("researchFormStatus");
const researchList = document.getElementById("researchList");
const researchCount = document.getElementById("researchCount");
const tabButtons = Array.from(document.querySelectorAll("[data-tab-button]"));
const tabPanels = Array.from(document.querySelectorAll("[data-tab-panel]"));

const state = {
  token: localStorage.getItem("ic_admin_token") || "",
  activeTab: "overview",
};

if (loginForm) {
  loginForm.addEventListener("submit", handleLogin);
}

if (researchForm) {
  researchForm.addEventListener("submit", handleResearchPublish);
}

if (refreshButton) {
  refreshButton.addEventListener("click", () => {
    void loadDashboard();
  });
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tabButton || "overview");
  });
});

if (state.token) {
  void loadDashboard();
}

function setActiveTab(tabName) {
  state.activeTab = tabName === "research" ? "research" : "overview";

  tabButtons.forEach((button) => {
    const isActive = button.dataset.tabButton === state.activeTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.tabPanel === state.activeTab;
    panel.classList.toggle("hidden", !isActive);
  });
}

async function handleLogin(event) {
  event.preventDefault();
  const formData = new FormData(loginForm);
  setError("");

  try {
    const response = await request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        email: String(formData.get("email") || ""),
        password: String(formData.get("password") || ""),
      }),
    });

    state.token = response.token;
    localStorage.setItem("ic_admin_token", response.token);
    await loadDashboard();
  } catch (error) {
    setError(error.message || "Failed to sign in.");
  }
}

async function handleResearchPublish(event) {
  event.preventDefault();
  const formData = new FormData(researchForm);
  setResearchFormStatus("", "");

  try {
    const response = await authedRequest("/api/admin/researches", {
      method: "POST",
      body: JSON.stringify({
        title: String(formData.get("title") || ""),
        authorName: String(formData.get("authorName") || ""),
        summary: String(formData.get("summary") || ""),
        content: String(formData.get("content") || ""),
      }),
    });

    researchForm.reset();
    await loadDashboard();
    setActiveTab("research");
    setResearchFormStatus(
      `Published "${response.research?.title || "research"}" to /research/.`,
      "success"
    );
  } catch (error) {
    setResearchFormStatus(error.message || "Failed to publish research.", "error");
  }
}

async function loadDashboard() {
  try {
    const [statsResponse, usersResponse, eventsResponse, researchResponse] =
      await Promise.all([
        authedRequest("/api/admin/stats"),
        authedRequest("/api/admin/users"),
        authedRequest("/api/admin/events"),
        authedRequest("/api/admin/researches"),
      ]);

    renderStats(statsResponse);
    renderBreakdown(statsResponse);
    renderEvents(eventsResponse.events || []);
    renderUsers(usersResponse.users || []);
    renderResearches(researchResponse.researches || []);

    loginPanel.classList.add("hidden");
    dashboardPanel.classList.remove("hidden");
    refreshButton.classList.remove("hidden");
    setActiveTab(state.activeTab);
  } catch (error) {
    state.token = "";
    localStorage.removeItem("ic_admin_token");
    dashboardPanel.classList.add("hidden");
    refreshButton.classList.add("hidden");
    loginPanel.classList.remove("hidden");
    setError(error.message || "Session expired.");
  }
}

function renderStats(stats) {
  const cards = [
    ["Users", stats.usersTotal, "Registered accounts"],
    ["Active", stats.activeSubscriptions, "Trial + active subscriptions"],
    ["Solves Today", stats.solvesToday, "Successful solve requests"],
    ["Debug Today", stats.debugToday, "Follow-up/debug runs"],
    ["Rate Limit Hits", stats.rateLimitHitsToday, "Blocked solve/debug attempts"],
    ["Est. MRR", `$${stats.monthlyRecurringRevenueEstimate}`, "Derived from active plans"],
  ];

  statsGrid.innerHTML = cards
    .map(
      ([title, value, note]) => `
        <article class="stat-card">
          <h3>${escapeHtml(title)}</h3>
          <strong>${escapeHtml(String(value))}</strong>
          <span>${escapeHtml(note)}</span>
        </article>
      `
    )
    .join("");
}

function renderBreakdown(stats) {
  const items = [
    ["Free", stats.plans.free],
    ["Pro", stats.plans.pro],
    ["Enterprise", stats.plans.enterprise],
    ["Trial", stats.statuses.trial],
    ["Past Due", stats.statuses.past_due],
    ["Suspended", stats.statuses.suspended],
  ];

  subscriptionBreakdown.innerHTML = items
    .map(
      ([label, value]) => `
        <div class="breakdown-item">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(value))}</strong>
        </div>
      `
    )
    .join("");
}

function renderEvents(events) {
  if (!events.length) {
    eventFeed.innerHTML = `<p class="muted">No usage events yet.</p>`;
    return;
  }

  eventFeed.innerHTML = events
    .map((event) => {
      const userLabel = event.user
        ? `${event.user.name} (${event.user.email})`
        : "Unknown user";

      return `
        <article class="event-card">
          <header>
            <strong>${escapeHtml(userLabel)}</strong>
            <span class="event-result ${event.allowed ? "allowed" : "blocked"}">
              ${event.allowed ? "Allowed" : "Blocked"}
            </span>
          </header>
          <p>
            ${escapeHtml(event.action)} at ${escapeHtml(formatDateTime(event.createdAt))}
          </p>
          <p>${escapeHtml(event.reason || "Request accepted and counted.")}</p>
        </article>
      `;
    })
    .join("");
}

function renderUsers(users) {
  if (!users.length) {
    usersTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="muted">No users registered yet.</td>
      </tr>
    `;
    return;
  }

  usersTableBody.innerHTML = users
    .map((user) => {
      const statusClass =
        user.subscriptionStatus === "active"
          ? "success"
          : user.subscriptionStatus === "trial"
            ? "warn"
            : "danger";

      return `
        <tr data-user-id="${escapeHtml(user.id)}">
          <td>
            <span class="user-name">${escapeHtml(user.name)}</span>
            <span class="user-email">${escapeHtml(user.email)}</span>
            <span class="mini-note">Created ${escapeHtml(formatDateTime(user.createdAt))}</span>
          </td>
          <td>
            <div class="action-stack">
              <span class="pill ${statusClass}">${escapeHtml(
                `${user.subscriptionPlan} / ${user.subscriptionStatus}`
              )}</span>
              <label class="mini-note">
                Plan
                <select data-field="plan">
                  ${option("free", user.subscriptionPlan)}
                  ${option("pro", user.subscriptionPlan)}
                  ${option("enterprise", user.subscriptionPlan)}
                </select>
              </label>
              <label class="mini-note">
                Status
                <select data-field="status">
                  ${option("trial", user.subscriptionStatus)}
                  ${option("active", user.subscriptionStatus)}
                  ${option("past_due", user.subscriptionStatus)}
                  ${option("cancelled", user.subscriptionStatus)}
                  ${option("suspended", user.subscriptionStatus)}
                </select>
              </label>
            </div>
          </td>
          <td>
            <strong>${escapeHtml(String(user.usage.solvesToday))}</strong> solves
            <span class="mini-note">${escapeHtml(String(user.usage.debugToday))} debug runs</span>
            <span class="mini-note">${escapeHtml(
              String(user.usage.requestsThisHour)
            )} requests this hour</span>
            <span class="mini-note">${escapeHtml(
              String(user.usage.blockedAttemptsToday)
            )} blocked today</span>
          </td>
          <td>
            <div class="limit-grid">
              <label>
                Solve/day
                <input data-field="solveDaily" type="number" min="1" value="${escapeHtml(
                  String(user.rateLimits.solveDaily)
                )}" />
              </label>
              <label>
                Debug/day
                <input data-field="debugDaily" type="number" min="1" value="${escapeHtml(
                  String(user.rateLimits.debugDaily)
                )}" />
              </label>
              <label>
                Req/hour
                <input data-field="requestsPerHour" type="number" min="1" value="${escapeHtml(
                  String(user.rateLimits.requestsPerHour)
                )}" />
              </label>
            </div>
          </td>
          <td>
            ${escapeHtml(formatDateTime(user.lastLoginAt))}
            <span class="mini-note">Last usage: ${escapeHtml(
              formatDateTime(user.usage.lastUsageAt)
            )}</span>
          </td>
          <td>
            <div class="action-stack">
              <button class="inline-button" data-action="save">Save</button>
              <button class="inline-button" data-action="defaults">Apply Plan Defaults</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  usersTableBody.querySelectorAll("button[data-action='save']").forEach((button) => {
    button.addEventListener("click", () => {
      void updateUser(button.closest("tr"), false);
    });
  });

  usersTableBody
    .querySelectorAll("button[data-action='defaults']")
    .forEach((button) => {
      button.addEventListener("click", () => {
        void updateUser(button.closest("tr"), true);
      });
    });
}

function renderResearches(researches) {
  researchCount.textContent = `${researches.length} published`;

  if (!researches.length) {
    researchList.innerHTML = `<p class="muted">No research has been published yet.</p>`;
    return;
  }

  researchList.innerHTML = researches
    .map((research) => {
      const publicHref = `/research/#${encodeURIComponent(research.slug)}`;
      return `
        <article class="research-card">
          <div class="research-card-header">
            <div>
              <h3>${escapeHtml(research.title)}</h3>
              <p class="mini-note-row">
                <span class="mini-note">${escapeHtml(research.authorName || "Sylica AI Research")}</span>
                <span class="mini-note">${escapeHtml(formatDateTime(research.publishedAt))}</span>
                <span class="mini-note">Slug: ${escapeHtml(research.slug)}</span>
              </p>
            </div>
            <a class="research-card-link" href="${publicHref}" target="_blank" rel="noreferrer">
              Open public page
            </a>
          </div>
          <p class="research-summary">${escapeHtml(research.summary)}</p>
          <p class="research-preview">${escapeHtml(summarizeLongText(research.content, 260))}</p>
        </article>
      `;
    })
    .join("");
}

async function updateUser(row, applyPlanDefaults) {
  if (!row) {
    return;
  }

  const userId = row.getAttribute("data-user-id");
  const payload = {
    subscriptionPlan: row.querySelector("[data-field='plan']").value,
    subscriptionStatus: row.querySelector("[data-field='status']").value,
    rateLimits: {
      solveDaily: Number(row.querySelector("[data-field='solveDaily']").value),
      debugDaily: Number(row.querySelector("[data-field='debugDaily']").value),
      requestsPerHour: Number(
        row.querySelector("[data-field='requestsPerHour']").value
      ),
    },
    applyPlanDefaults,
  };

  try {
    await authedRequest(`/api/admin/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    await loadDashboard();
  } catch (error) {
    alert(error.message || "Failed to update user.");
  }
}

function setResearchFormStatus(message, tone) {
  if (!message) {
    researchFormStatus.textContent = "";
    researchFormStatus.className = "form-status hidden";
    return;
  }

  researchFormStatus.textContent = message;
  researchFormStatus.className = `form-status ${tone || ""}`.trim();
}

function summarizeLongText(value, maxLength) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await safeJson(response);
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

async function authedRequest(path, options = {}) {
  return request(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {}),
    },
  });
}

async function safeJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function option(value, selectedValue) {
  return `<option value="${escapeHtml(value)}" ${
    value === selectedValue ? "selected" : ""
  }>${escapeHtml(value)}</option>`;
}

function setError(message) {
  if (!message) {
    loginError.textContent = "";
    loginError.classList.add("hidden");
    return;
  }

  loginError.textContent = message;
  loginError.classList.remove("hidden");
}

function formatDateTime(value) {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
