// Background script for Tab Dashboard Extension

let tabTimeTracking = new Map();
let currentActiveTab = null;
let sessionStartTime = Date.now();

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log("Tab Dashboard Extension installed");

  // Set up default settings
  chrome.storage.local.set({
    tabAnalytics: {},
    focusSettings: {
      duration: 25,
      breakDuration: 5,
      longBreakDuration: 15,
    },
    dashboardSettings: {
      theme: "dark",
      autoFocus: false,
      notifications: true,
    },
  });

  // Create context menu
  chrome.contextMenus.create({
    id: "openDashboard",
    title: "Open Tab Dashboard",
    contexts: ["page", "tab"],
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "openDashboard") {
    openDashboard();
  }
});

// Track tab activation
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  trackTabSwitch(tab);
});

// Track tab updates (URL changes)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    trackTabSwitch(tab);
  }
});

// Track window focus changes
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Browser lost focus
    if (currentActiveTab) {
      pauseTabTracking();
    }
  } else {
    // Browser gained focus
    chrome.tabs.query({ active: true, windowId: windowId }, (tabs) => {
      if (tabs[0]) {
        trackTabSwitch(tabs[0]);
      }
    });
  }
});

function trackTabSwitch(tab) {
  const now = Date.now();

  // Stop tracking previous tab
  if (currentActiveTab) {
    saveTabTime(currentActiveTab, now);
  }

  // Start tracking new tab
  currentActiveTab = {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    startTime: now,
  };

  // Initialize tracking for new domains
  const domain = extractDomain(tab.url);
  if (!tabTimeTracking.has(domain)) {
    tabTimeTracking.set(domain, {
      totalTime: 0,
      sessions: [],
      lastVisit: now,
    });
  }
}

function saveTabTime(tabInfo, endTime) {
  const domain = extractDomain(tabInfo.url);
  const sessionTime = endTime - tabInfo.startTime;

  if (tabTimeTracking.has(domain)) {
    const tracking = tabTimeTracking.get(domain);
    tracking.totalTime += sessionTime;
    tracking.sessions.push({
      startTime: tabInfo.startTime,
      endTime: endTime,
      duration: sessionTime,
      title: tabInfo.title,
    });
    tracking.lastVisit = endTime;
  }

  // Save to storage
  saveAnalyticsData();
}

function pauseTabTracking() {
  if (currentActiveTab) {
    saveTabTime(currentActiveTab, Date.now());
    currentActiveTab = null;
  }
}

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

async function saveAnalyticsData() {
  const analyticsData = {};

  for (let [domain, data] of tabTimeTracking) {
    analyticsData[domain] = {
      totalTime: data.totalTime,
      sessionsCount: data.sessions.length,
      lastVisit: data.lastVisit,
      avgSessionTime:
        data.sessions.length > 0 ? data.totalTime / data.sessions.length : 0,
    };
  }

  await chrome.storage.local.set({
    tabAnalytics: analyticsData,
    lastUpdate: Date.now(),
  });
}

// Load existing analytics data on startup
chrome.storage.local.get(["tabAnalytics"], (result) => {
  if (result.tabAnalytics) {
    // Restore tracking data
    for (let [domain, data] of Object.entries(result.tabAnalytics)) {
      tabTimeTracking.set(domain, {
        totalTime: data.totalTime,
        sessions: [],
        lastVisit: data.lastVisit,
      });
    }
  }
});

// Open dashboard function
function openDashboard() {
  chrome.tabs.create({
    url: chrome.runtime.getURL("dashboard.html"),
  });
}

// Handle extension icon click
chrome.action.onClicked.addListener(() => {
  openDashboard();
});

// Focus mode functionality
let focusSession = {
  active: false,
  startTime: null,
  duration: 25 * 60 * 1000, // 25 minutes
  blockedSites: [],
};

// Block distracting sites during focus mode
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (focusSession.active) {
      const url = new URL(details.url);
      const domain = url.hostname;

      // Check if site is in blocked list
      if (
        focusSession.blockedSites.some((blocked) => domain.includes(blocked))
      ) {
        return { redirectUrl: chrome.runtime.getURL("focus-blocked.html") };
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

// Listen for messages from popup/dashboard
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case "getAnalytics":
      sendResponse({
        analytics: Object.fromEntries(tabTimeTracking),
        currentSession: currentActiveTab,
      });
      break;

    case "startFocus":
      startFocusSession(request.duration, request.blockedSites);
      sendResponse({ success: true });
      break;

    case "stopFocus":
      stopFocusSession();
      sendResponse({ success: true });
      break;

    case "getAllTabs":
      chrome.tabs.query({}, (tabs) => {
        sendResponse({ tabs });
      });
      return true; // Keep message channel open

    case "closeTab":
      chrome.tabs.remove(request.tabId);
      sendResponse({ success: true });
      break;

    case "switchToTab":
      chrome.tabs.update(request.tabId, { active: true });
      sendResponse({ success: true });
      break;
  }
});

function startFocusSession(duration, blockedSites) {
  focusSession = {
    active: true,
    startTime: Date.now(),
    duration: duration * 60 * 1000,
    blockedSites: blockedSites || [
      "facebook.com",
      "twitter.com",
      "instagram.com",
      "youtube.com",
    ],
  };

  // Set timer to end focus session
  setTimeout(() => {
    if (focusSession.active) {
      stopFocusSession();

      // Send notification
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "Focus Session Complete!",
        message: "Great job! Time for a short break.",
      });
    }
  }, focusSession.duration);
}

function stopFocusSession() {
  focusSession.active = false;
  focusSession.startTime = null;
}

// Daily analytics reset
function checkDailyReset() {
  const now = new Date();
  const today = now.toDateString();

  chrome.storage.local.get(["lastResetDate"], (result) => {
    if (result.lastResetDate !== today) {
      // New day, archive yesterday's data and reset
      archiveDailyData();
      resetDailyTracking();

      chrome.storage.local.set({
        lastResetDate: today,
      });
    }
  });
}

function archiveDailyData() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateKey = yesterday.toISOString().split("T")[0];

  chrome.storage.local.get(["historicalData"], (result) => {
    const historical = result.historicalData || {};
    historical[dateKey] = Object.fromEntries(tabTimeTracking);

    chrome.storage.local.set({ historicalData: historical });
  });
}

function resetDailyTracking() {
  tabTimeTracking.clear();
  currentActiveTab = null;
  sessionStartTime = Date.now();
}

// Check for daily reset every hour
setInterval(checkDailyReset, 60 * 60 * 1000);
checkDailyReset(); // Check on startup
