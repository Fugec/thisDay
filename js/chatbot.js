// This script provides an AI chatbot interface to help users explore historical events
// on specific dates. It includes date parsing, response generation, and UI handling.

// --- CHATBOT VARIABLES ---
let chatbotOpen = false;
let chatHistory = [];
let isProcessingMessage = false;

// --- PAGE DETECTION ---
function isMainCalendarPage() {
  // Check if we're on the main calendar page by looking for calendar-specific elements
  return (
    document.querySelector("#calendar") !== null ||
    document.querySelector(".calendar-container") !== null ||
    window.location.pathname === "/" ||
    window.location.pathname === "/index.html" ||
    window.location.pathname === "/index.php" ||
    (window.location.hostname === "thisday.info" &&
      window.location.pathname === "/")
  );
}

function redirectToMainPage(parsedDate) {
  // Build the redirect URL with date parameters
  const baseUrl = "https://thisday.info/";
  const params = new URLSearchParams();

  if (parsedDate.year) params.append("year", parsedDate.year);
  if (parsedDate.month !== null) params.append("month", parsedDate.month + 1); // Convert to 1-based
  if (parsedDate.day) params.append("day", parsedDate.day);

  const redirectUrl =
    baseUrl + (params.toString() ? "?" + params.toString() : "");
  window.location.href = redirectUrl;
}

// --- DATE PARSING UTILITIES ---
const monthAbbreviations = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

// Enhanced date parsing function
function parseUserDate(userInput) {
  const input = userInput.toLowerCase().trim();

  const cleanInput = input
    .replace(
      /\b(on|the|of|in|at|for|about|what|happened|events|history|historical)\b/g,
      ""
    )
    .trim();

  const patterns = [
    /(\w+)\s+(\d{1,2}),?\s+(\d{4})/, // August 5 2020
    /(\d{1,2})\s+(\w+)\s+(\d{4})/, // 5 August 2020
    /(\w+)\s+(\d{1,2})/, // August 5
    /(\d{1,2})\s+(\w+)/, // 5 August
    /(\d{4})-(\d{1,2})-(\d{1,2})/, // 2020-08-05
    /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/, // 8/5 or 8/5/2020
    /^(\w+)$/, // Just month
    /^(\d{4})$/, // Just year
  ];

  let result = { month: null, day: null, year: null };

  for (const pattern of patterns) {
    const match = cleanInput.match(pattern);
    if (match) {
      if (pattern.source.includes("(\\d{4})-(\\d{1,2})-(\\d{1,2})")) {
        result.year = parseInt(match[1]);
        result.month = parseInt(match[2]) - 1;
        result.day = parseInt(match[3]);
      } else if (pattern.source.includes("(\\d{1,2})\\/(\\d{1,2})")) {
        result.month = parseInt(match[1]) - 1;
        result.day = parseInt(match[2]);
        if (match[3]) result.year = parseInt(match[3]);
      } else if (pattern.source.includes("(\\w+)\\s+(\\d{1,2})")) {
        const monthRaw = getClosestMonth(match[1]);
        if (monthRaw && monthAbbreviations.hasOwnProperty(monthRaw)) {
          result.month = monthAbbreviations[monthRaw];
          result.day = parseInt(match[2]);
          if (match[3]) result.year = parseInt(match[3]);
        }
      } else if (pattern.source.includes("(\\d{1,2})\\s+(\\w+)")) {
        const monthRaw = getClosestMonth(match[2]);
        if (monthRaw && monthAbbreviations.hasOwnProperty(monthRaw)) {
          result.day = parseInt(match[1]);
          result.month = monthAbbreviations[monthRaw];
          if (match[3]) result.year = parseInt(match[3]);
        }
      } else if (pattern.source === "^(\\w+)$") {
        const monthRaw = getClosestMonth(match[1]);
        if (monthRaw && monthAbbreviations.hasOwnProperty(monthRaw)) {
          result.month = monthAbbreviations[monthRaw];
        }
      } else if (pattern.source === "^(\\d{4})$") {
        result.year = parseInt(match[1]);
      }
      break;
    }
  }

  if (result.month === null && result.day === null && result.year === null) {
    return null;
  }

  return result;
}

function getClosestMonth(input) {
  const threshold = 2;
  const months = Object.keys(monthAbbreviations);

  let bestMatch = null;
  let bestDistance = Infinity;

  for (const month of months) {
    const dist = levenshtein(input, month);
    if (dist < bestDistance && dist <= threshold) {
      bestDistance = dist;
      bestMatch = month;
    }
  }

  return bestMatch;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[a.length][b.length];
}

// Validate parsed date
function validateDate(parsedDate) {
  const now = new Date();
  const currentYear = now.getFullYear();

  // Set defaults
  if (parsedDate.year === null) {
    parsedDate.year = currentYear;
  }
  if (parsedDate.month === null) {
    parsedDate.month = now.getMonth();
  }
  if (parsedDate.day === null) {
    parsedDate.day = 1; // Default to first day of month
  }

  // Validate ranges
  if (parsedDate.month < 0 || parsedDate.month > 11) return false;
  if (parsedDate.day < 1 || parsedDate.day > 31) return false;
  if (parsedDate.year < 1000 || parsedDate.year > currentYear + 10)
    return false;

  // Check if day is valid for the month
  const daysInMonth = new Date(
    parsedDate.year,
    parsedDate.month + 1,
    0
  ).getDate();
  if (parsedDate.day > daysInMonth) return false;

  return true;
}

// --- CHATBOT RESPONSE GENERATION ---
function generateChatbotResponse(userInput, parsedDate = null) {
  const responses = {
    greeting: [
      "Hi there! I'm your historical events assistant. Which date interests you? You can say something like 'August 5', 'December 25' or just 'January'.",
      "Hello! I can help you explore historical events from any date. What date would you like to learn about?",
      "Welcome! I'm here to help you discover what happened on any date in history. Just tell me a date!",
    ],
    dateFound: [
      "Great! Let me show you the historical events for {date}.",
      "Found it! Here are the events that happened on {date}.",
      "Perfect! Switching to {date} to show you what happened on this day.",
    ],
    dateFoundRedirect: [
      "Great! I'll take you to the main calendar page to show you the historical events for {date}.",
      "Found it! Redirecting you to see the events that happened on {date}.",
      "Perfect! Taking you to the calendar to explore {date}.",
    ],
    dateNotFound: [
      "I couldn't quite understand that date. Could you try again? For example: 'August 5'.",
      "I'm having trouble parsing that date. Please try formats like 'January 15' or 'July 4'.",
      "That doesn't look like a date I can understand. Try something like 'March 3'.",
    ],
    help: [
      "You can ask me about any date! Try: 'August 5', 'December 25', 'What happened on July 4?', or just 'January'.",
      "I understand many date formats: 'August 5', 'Aug 5', or even just 'August'.",
      "Just tell me a date and I'll show you the historical events! Examples: 'September 11', 'Christmas Day', 'New Year's Day'.",
    ],
    helpRedirect: [
      "You can ask me about any date! I'll take you to the main calendar page to explore the events. Try: 'August 5', 'December 25', or 'What happened on July 4?'",
      "I understand many date formats and will redirect you to the calendar: 'August 5', 'Aug 5', or even just 'August'.",
      "Just tell me a date and I'll take you to the main page to show you the historical events! Examples: 'September 11', 'Christmas Day', 'New Year's Day'.",
    ],
    error: [
      "I'm having some trouble right now. Please try again in a moment.",
      "Oops! Something went wrong. Could you try asking again?",
      "I encountered an error. Please try your request again.",
    ],
  };

  const randomResponse = (category) => {
    const options = responses[category];
    return options[Math.floor(Math.random() * options.length)];
  };

  // Determine response type
  const lowerInput = userInput.toLowerCase();
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  if (
    lowerInput.includes("help") ||
    lowerInput.includes("how") ||
    lowerInput.includes("what can")
  ) {
    return isMainCalendarPage()
      ? randomResponse("help")
      : randomResponse("helpRedirect");
  }

  if (parsedDate && validateDate(parsedDate)) {
    const dateStr = `${monthNames[parsedDate.month]} ${parsedDate.day}, ${
      parsedDate.year
    }`;
    if (isMainCalendarPage()) {
      return randomResponse("dateFound").replace("{date}", dateStr);
    } else {
      return randomResponse("dateFoundRedirect").replace("{date}", dateStr);
    }
  }

  if (parsedDate && !validateDate(parsedDate)) {
    return randomResponse("dateNotFound");
  }

  if (chatHistory.length === 0) {
    return randomResponse("greeting");
  }

  return randomResponse("dateNotFound");
}

// --- CHATBOT UI FUNCTIONS ---
function createChatbotHTML() {
  return `
    <!-- Chatbot Toggle Button -->
    <button id="chatbotToggle" class="chatbot-toggle" aria-label="Open AI Assistant">
      <i class="bi bi-chat-dots"></i>
    </button>
    
    <!-- Chatbot Modal -->
    <div id="chatbotModal" class="chatbot-modal" style="display: none;">
      <div class="chatbot-header">
        <h6><i class="bi bi-robot" style="margin-right: 15px;"></i>thisDay Assistant</h6>
        <span id="chatbotClose" style="font-size: 20px; margin-right: 10px;" aria-label="Close chat"">x</span>
      </div>
      <div id="chatbotMessages" class="chatbot-messages">
        <div class="message bot-message">
          <div class="message-content">
            Hi! I'm your historical events assistant. Which date interests you? You can say something like "August 5", or just "August".
          </div>
          <div class="message-time">${new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}</div>
        </div>
      </div>
      <div class="chatbot-input">
        <input type="text" id="chatbotInput" placeholder="Ask about any date..." maxlength="200">
        <button id="chatbotSend" aria-label="Send message">
          <i class="bi bi-send"></i>
        </button>
      </div>
    </div>
  `;
}

// Add message to chat
function addMessageToChat(message, isUser = false) {
  const messagesContainer = document.getElementById("chatbotMessages");
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isUser ? "user-message" : "bot-message"}`;

  const currentTime = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  messageDiv.innerHTML = `
    <div class="message-content">${message}</div>
    <div class="message-time">${currentTime}</div>
  `;

  messagesContainer.appendChild(messageDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // Store in history
  chatHistory.push({
    message: message,
    isUser: isUser,
    timestamp: new Date(),
  });
}

// Show typing indicator
function showTypingIndicator() {
  const messagesContainer = document.getElementById("chatbotMessages");
  const typingDiv = document.createElement("div");
  typingDiv.className = "message bot-message typing-indicator";
  typingDiv.id = "typingIndicator";

  typingDiv.innerHTML = `
    <div class="message-content">
      <div class="typing-dots">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>
  `;

  messagesContainer.appendChild(typingDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Remove typing indicator
function removeTypingIndicator() {
  const typingIndicator = document.getElementById("typingIndicator");
  if (typingIndicator) {
    typingIndicator.remove();
  }
}

// Navigate to specific date (only works on main calendar page)
async function navigateToDate(parsedDate) {
  try {
    // Check if we have the necessary functions available
    if (
      typeof renderCalendar !== "function" ||
      typeof currentDate === "undefined"
    ) {
      console.warn(
        "Calendar functions not available - not on main calendar page"
      );
      return false;
    }

    // Create new date object
    const targetDate = new Date(
      parsedDate.year,
      parsedDate.month,
      parsedDate.day
    );

    // Update current date
    currentDate = targetDate;

    // Re-render calendar
    await renderCalendar();

    // Find and highlight the specific day if it exists
    const dayCard = document.querySelector(
      `[data-day="${parsedDate.day}"][data-month="${parsedDate.month + 1}"]`
    );
    if (dayCard) {
      setTimeout(() => {
        dayCard.scrollIntoView({ behavior: "smooth", block: "center" });
        dayCard.classList.add("highlight-pulse");
        setTimeout(() => dayCard.classList.remove("highlight-pulse"), 2000);
      }, 500);
    }

    return true;
  } catch (error) {
    console.error("Error navigating to date:", error);
    return false;
  }
}

// Process user message
async function processUserMessage(userInput) {
  if (isProcessingMessage) return;

  isProcessingMessage = true;
  const sendButton = document.getElementById("chatbotSend");
  const inputField = document.getElementById("chatbotInput");

  // Disable input while processing
  sendButton.disabled = true;
  inputField.disabled = true;

  // Add user message to chat
  addMessageToChat(userInput, true);

  // Show typing indicator
  showTypingIndicator();

  try {
    // Parse the user input for date
    const parsedDate = parseUserDate(userInput);

    // Generate response
    const response = generateChatbotResponse(userInput, parsedDate);

    // Simulate processing delay
    await new Promise((resolve) =>
      setTimeout(resolve, 1000 + Math.random() * 1000)
    );

    // Remove typing indicator
    removeTypingIndicator();

    // Add bot response
    addMessageToChat(response, false);

    // If valid date found, either navigate or redirect
    if (parsedDate && validateDate(parsedDate)) {
      if (isMainCalendarPage()) {
        // We're on the main calendar page - navigate normally
        const success = await navigateToDate(parsedDate);
        if (success) {
          setTimeout(() => {
            addMessageToChat(
              "I've switched the calendar to show events for this date. You can scroll down to see the calendar or click on any day to explore more events!",
              false
            );
          }, 500);
        } else {
          setTimeout(() => {
            addMessageToChat(
              "I found the date but had trouble switching the calendar. Please try manually navigating to the date.",
              false
            );
          }, 500);
        }
      } else {
        // We're on a different page - redirect to main page
        setTimeout(() => {
          addMessageToChat(
            "Taking you to the main calendar page now...",
            false
          );
          setTimeout(() => {
            redirectToMainPage(parsedDate);
          }, 1000);
        }, 500);
      }
    }
  } catch (error) {
    console.error("Error processing message:", error);
    removeTypingIndicator();
    addMessageToChat(
      "I'm having some trouble right now. Please try again in a moment.",
      false
    );
  } finally {
    // Re-enable input
    sendButton.disabled = false;
    inputField.disabled = false;
    inputField.focus();
    isProcessingMessage = false;
  }
}

// Initialize chatbot
function initializeChatbot() {
  // Add HTML
  document.body.insertAdjacentHTML("beforeend", createChatbotHTML());

  // Add highlight pulse animation
  const pulseStyle = document.createElement("style");
  pulseStyle.textContent = `
    .highlight-pulse {
      animation: highlightPulse 2s ease-in-out;
    }
    
    @keyframes highlightPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); box-shadow: 0 0 20px rgba(102, 126, 234, 0.5); }
    }
  `;
  document.head.appendChild(pulseStyle);

  // Get elements
  const chatbotToggle = document.getElementById("chatbotToggle");
  const chatbotModal = document.getElementById("chatbotModal");
  const chatbotClose = document.getElementById("chatbotClose");
  const chatbotInput = document.getElementById("chatbotInput");
  const chatbotSend = document.getElementById("chatbotSend");

  // Toggle chatbot
  chatbotToggle.addEventListener("click", () => {
    chatbotOpen = !chatbotOpen;
    chatbotModal.style.display = chatbotOpen ? "flex" : "none";

    if (chatbotOpen) {
      chatbotInput.focus();
    }
  });

  // Close chatbot
  chatbotClose.addEventListener("click", () => {
    chatbotOpen = false;
    chatbotModal.style.display = "none";
  });

  // Send message
  const sendMessage = () => {
    const message = chatbotInput.value.trim();
    if (message && !isProcessingMessage) {
      processUserMessage(message);
      chatbotInput.value = "";
    }
  };

  chatbotSend.addEventListener("click", sendMessage);

  chatbotInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      sendMessage();
    }
  });

  // Close chatbot when clicking outside
  document.addEventListener("click", (e) => {
    if (
      chatbotOpen &&
      !chatbotModal.contains(e.target) &&
      !chatbotToggle.contains(e.target)
    ) {
      chatbotOpen = false;
      chatbotModal.style.display = "none";
    }
  });
}

// Handle URL parameters on page load (for when user is redirected with date params)
function handleUrlParameters() {
  const urlParams = new URLSearchParams(window.location.search);
  const year = urlParams.get("year");
  const month = urlParams.get("month");
  const day = urlParams.get("day");

  if (year || month || day) {
    const parsedDate = {
      year: year ? parseInt(year) : new Date().getFullYear(),
      month: month ? parseInt(month) - 1 : new Date().getMonth(), // Convert to 0-based
      day: day ? parseInt(day) : 1,
    };

    if (validateDate(parsedDate) && isMainCalendarPage()) {
      // Wait for calendar to be ready, then navigate
      setTimeout(() => {
        navigateToDate(parsedDate);
      }, 2000);
    }
  }
}

// Initialize chatbot when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  // Handle URL parameters first
  handleUrlParameters();

  // Wait a bit for the main app to initialize
  setTimeout(initializeChatbot, 1000);
});

// Export functions for potential external use
window.chatbotAPI = {
  parseUserDate,
  validateDate,
  navigateToDate,
  processUserMessage,
  redirectToMainPage,
  isMainCalendarPage,
};
