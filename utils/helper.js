const mimeDB = require("mime-db");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Define media types (only document and photo are supported)
const MEDIA_TYPES = {
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  STICKER: "sticker",
  DOCUMENT: "document",
  OTHERS: "others",
};

// Define console colors for logging
const consoleColors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  reset: "\x1b[0m",
};

// Get the media type of a message (only document and photo are supported)
const getMediaType = (message) => {
  if (!message.media) return MEDIA_TYPES.OTHERS;

  const { media } = message;

  // Photos
  if (media.photo) return MEDIA_TYPES.IMAGE;

  // Documents (videos, audio, files, stickers, etc.)
  if (media.document) {
    const { mimeType } = media.document;
    if (mimeType) {
      if (mimeType.includes(MEDIA_TYPES.IMAGE)) return MEDIA_TYPES.IMAGE;
      if (mimeType.includes(MEDIA_TYPES.VIDEO)) return MEDIA_TYPES.VIDEO;
      if (mimeType.includes(MEDIA_TYPES.AUDIO)) return MEDIA_TYPES.AUDIO;
      if (mimeType.includes(MEDIA_TYPES.STICKER)) return MEDIA_TYPES.STICKER;
    }
    return MEDIA_TYPES.DOCUMENT;
  }

  // All other media types (webpage, poll, geo, contact, venue) are not supported
  return MEDIA_TYPES.OTHERS;
};

// Check if a file already exists
const checkFileExist = (message, outputFolder) => {
  if (!message || !message.media) return false;

  let fileName = `${message.id}_file`;
  let hasFileNameFromDocument = false;
  const { media } = message;

  if (media.document) {
    const docAttributes = media.document.attributes;
    if (docAttributes) {
      const fileNameObj = docAttributes.find(
        (e) => e.className === "DocumentAttributeFilename"
      );
      if (fileNameObj) {
        fileName = fileNameObj.fileName;
        hasFileNameFromDocument = true;
      } else {
        const ext = mimeDB[media.document.mimeType]?.extensions[0];
        if (ext) fileName += `.${ext}`;
        hasFileNameFromDocument = true;
      }
    }
  }

  // Only add extensions if we didn't get a filename from document attributes
  if (!hasFileNameFromDocument) {
    if (media.video) fileName += ".mp4";
    if (media.audio) fileName += ".mp3";
    if (media.photo) fileName += ".jpg";
  }

  const folderType = filterString(getMediaType(message));
  const filePath = path.join(outputFolder, folderType, fileName);

  return fs.existsSync(filePath);
};

// Get the path to save the media file
const getMediaPath = (message, outputFolder) => {
  if (!message || !message.media) return "unknown";

  let fileName = `${message.id}_file`;
  let hasFileNameFromDocument = false;
  const { media } = message;

  if (media.document) {
    const docAttributes = media.document.attributes;
    if (docAttributes) {
      const fileNameObj = docAttributes.find(
        (e) => e.className === "DocumentAttributeFilename"
      );
      if (fileNameObj) {
        fileName = fileNameObj.fileName;
        hasFileNameFromDocument = true;
      } else {
        const ext = mimeDB[media.document.mimeType]?.extensions[0];
        if (ext) fileName += `.${ext}`;
        hasFileNameFromDocument = true;
      }
    }
  }

  // Only add extensions if we didn't get a filename from document attributes
  if (!hasFileNameFromDocument) {
    if (media.video) fileName += ".mp4";
    if (media.audio) fileName += ".mp3";
    if (media.photo) fileName += ".jpg";
  }

  const folderType = filterString(getMediaType(message));
  const filePath = path.join(outputFolder, folderType, fileName);

  if (fs.existsSync(filePath)) {
    // Only rename if this is a true collision (different message, same filename)
    // Skip if filename already contains this message's ID (same message processed again)
    const filenameHasMessageId = fileName.includes(String(message.id));
    if (!filenameHasMessageId) {
      const ext = path.extname(filePath);
      const baseName = path.basename(filePath, ext);
      const newFileName = `${baseName}_${message.id}${ext}`;
      logMessage.info(`File already exists: ${baseName}${ext}, renaming to ${newFileName}`);
      fileName = newFileName;
    }
  }

  const finalPath = path.join(outputFolder, folderType, fileName);
  if (!fs.existsSync(path.dirname(finalPath))) {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  }

  return finalPath;
};

// Get the type of dialog
const getDialogType = (dialog) => {
  if (dialog.isChannel) return "Channel";
  if (dialog.isGroup) return "Group";
  if (dialog.isUser) return "User";
  return "Unknown";
};

// Logging utility
const logMessage = {
  info: (message, icon=true) => {
    console.log(`📢: ${consoleColors.magenta}${message}${consoleColors.reset}`);
  },
  error: (message) => {
    console.log(`❌ ${consoleColors.red}${message}${consoleColors.reset}`);
  },
  success: (message) => {
    console.log(`✅ ${consoleColors.cyan}${message}${consoleColors.reset}`);
  },
  debug: (message) => {
    console.log(`⚠️ ${message}`);
  },
};

// Wait for a specified number of seconds
const wait = (seconds) => {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
};

/**
 * Parses a date string in DD/MM/YYYY or DD/MM/YYYY HH:MM format to Unix timestamps
 * @param {string} dateStr - Date string in DD/MM/YYYY or DD/MM/YYYY HH:MM format
 * @param {boolean} endOfDay - If true and no time provided, returns end of day (23:59:59), otherwise start of day (00:00:00)
 * @returns {number|null} Unix timestamp in seconds, or null if invalid
 */
const parseDateString = (dateStr, endOfDay = false) => {
  if (!dateStr || typeof dateStr !== "string") return null;

  // Try to match DD/MM/YYYY HH:MM format first
  const regexWithTime = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/;
  const matchWithTime = dateStr.match(regexWithTime);

  // Fall back to DD/MM/YYYY format
  const regexDateOnly = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const matchDateOnly = dateStr.match(regexDateOnly);

  if (!matchWithTime && !matchDateOnly) return null;

  const match = matchWithTime || matchDateOnly;
  const hasTime = !!matchWithTime;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1; // JavaScript months are 0-indexed
  const year = parseInt(match[3], 10);

  // Validate date ranges
  if (month < 0 || month > 11) return null;
  if (day < 1 || day > 31) return null;

  const date = new Date(year, month, day);

  // Verify the date is valid (e.g., not Feb 30)
  if (date.getDate() !== day || date.getMonth() !== month || date.getFullYear() !== year) {
    return null;
  }

  if (hasTime) {
    const hours = parseInt(match[4], 10);
    const minutes = parseInt(match[5], 10);

    // Validate time ranges
    if (hours < 0 || hours > 23) return null;
    if (minutes < 0 || minutes > 59) return null;

    date.setHours(hours, minutes, 0, 0);
  } else if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }

  // Return Unix timestamp in seconds (Telegram uses seconds, not milliseconds)
  return Math.floor(date.getTime() / 1000);
};

// Filter a string to remove non-alphanumeric characters
const filterString = (string) => {
  return string.replace(/[^a-zA-Z0-9]/g, "");
};

// Stringify an object with circular references
const circularStringify = (obj, indent = 2) => {
  const cache = new Set();
  const retVal = JSON.stringify(
    obj,
    (key, value) =>
      typeof value === "object" && value !== null
        ? cache.has(value)
          ? undefined
          : cache.add(value) && value
        : value,
    indent
  );
  cache.clear();
  return retVal;
};

// Append data to a JSON array file
const appendToJSONArrayFile = (filePath, dataToAppend) => {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, circularStringify(dataToAppend, null, 2));
    } else {
      const data = fs.readFileSync(filePath);
      const json = JSON.parse(data);
      json.push(dataToAppend);
      fs.writeFileSync(filePath, circularStringify(json, null, 2));
    }
  } catch (e) {
    logMessage.error(`Error appending to JSON Array file ${filePath}`);
    console.error(e);
  }
};

/**
 * Sanitizes a string for use as a folder name
 * Removes/replaces invalid filesystem characters
 * @param {string} name - The name to sanitize
 * @param {number} maxLength - Maximum length for the sanitized name
 * @returns {string} Sanitized folder name
 */
const sanitizeFolderName = (name, maxLength = 50) => {
  if (!name || typeof name !== "string") return "";

  return name
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "_") // Replace invalid filesystem chars
    .replace(/\s+/g, "_")           // Replace spaces with underscore
    .replace(/_+/g, "_")            // Collapse multiple underscores
    .replace(/^_|_$/g, "")          // Remove leading/trailing underscores
    .substring(0, maxLength);
};

/**
 * Creates a safe folder name from channel name and ID
 * Format: SanitizedName_SanitizedId (e.g., "My_Channel_1002858083105")
 * @param {string} channelName - The display name of the channel
 * @param {number|string} channelId - The channel ID (may be negative)
 * @returns {string} Safe folder name
 */
const createChannelFolderName = (channelName, channelId) => {
  // Sanitize the ID: convert to string and remove leading dash
  const sanitizedId = String(channelId).replace(/^-/, "");

  // Sanitize the channel name
  const sanitizedName = sanitizeFolderName(channelName);

  // Combine name and ID, or use fallback if name is empty
  if (sanitizedName) {
    return `${sanitizedName}_${sanitizedId}`;
  }
  return `channel_${sanitizedId}`;
};

/**
 * Gets the export directory path.
 * Uses the OS Downloads folder if available, otherwise falls back to home directory.
 * @returns {string} The export directory path
 */
const getExportDirectory = () => {
  const homeDir = os.homedir();
  const downloadsDir = path.join(homeDir, "Downloads");

  if (fs.existsSync(downloadsDir)) {
    return downloadsDir;
  }
  return homeDir;
};

/**
 * Gets the tracking directory path for storing state/metadata files.
 * Creates a hidden .telegram-channel-downloader folder in the export directory.
 * @returns {string} The tracking directory path
 */
const getTrackingDirectory = () => {
  const trackingDir = path.join(getExportDirectory(), ".telegram-channel-downloader");
  if (!fs.existsSync(trackingDir)) {
    fs.mkdirSync(trackingDir, { recursive: true });
  }
  return trackingDir;
};

/**
 * Gets the per-channel tracking directory for storing channel-specific state files.
 * @param {string} channelFolderName - The channel folder name (e.g., "ChannelName_123456")
 * @returns {string} The channel tracking directory path
 */
const getChannelTrackingDirectory = (channelFolderName) => {
  const channelTrackingDir = path.join(getTrackingDirectory(), channelFolderName);
  if (!fs.existsSync(channelTrackingDir)) {
    fs.mkdirSync(channelTrackingDir, { recursive: true });
  }
  return channelTrackingDir;
};

module.exports = {
  getMediaType,
  checkFileExist,
  getMediaPath,
  getDialogType,
  logMessage,
  wait,
  parseDateString,
  filterString,
  appendToJSONArrayFile,
  circularStringify,
  sanitizeFolderName,
  createChannelFolderName,
  getExportDirectory,
  getTrackingDirectory,
  getChannelTrackingDirectory,
  MEDIA_TYPES,
};
