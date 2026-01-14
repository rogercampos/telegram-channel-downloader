"use strict";

/**
 * Utility functions for parsing Telegram URLs and extracting links from messages.
 */

/**
 * Parses a Telegram URL and extracts channel/username and message ID.
 *
 * Supported formats:
 * - https://t.me/c/2623426951/3/17039  → Private channel with thread (channelId: 2623426951, messageId: 17039)
 * - https://t.me/c/2623426951/17039    → Private channel (channelId: 2623426951, messageId: 17039)
 * - https://t.me/channelname/12345     → Public channel by username (username: channelname, messageId: 12345)
 *
 * @param {string} url - The Telegram URL to parse
 * @returns {Object|null} Parsed result with either channelId or username, plus messageId. Null if invalid.
 */
const parseTelegramUrl = (url) => {
  if (!url || typeof url !== "string") return null;

  try {
    const urlObj = new URL(url);

    // Must be a t.me URL
    if (!urlObj.hostname.endsWith("t.me")) return null;

    const pathParts = urlObj.pathname.split("/").filter(Boolean);

    if (pathParts.length < 2) return null;

    // Private channel format: /c/channelId/[threadId/]messageId
    if (pathParts[0] === "c") {
      const channelId = pathParts[1];

      if (!channelId || !/^\d+$/.test(channelId)) return null;

      // Could be /c/channelId/messageId or /c/channelId/threadId/messageId
      let messageId;
      if (pathParts.length === 3) {
        // /c/channelId/messageId
        messageId = pathParts[2];
      } else if (pathParts.length >= 4) {
        // /c/channelId/threadId/messageId - last part is the message ID
        messageId = pathParts[pathParts.length - 1];
      }

      if (!messageId || !/^\d+$/.test(messageId)) return null;

      return {
        channelId: parseInt(channelId, 10),
        messageId: parseInt(messageId, 10),
        isPrivate: true,
      };
    }

    // Public channel format: /username/messageId
    const username = pathParts[0];
    const messageId = pathParts[pathParts.length - 1];

    // Username validation: alphanumeric and underscores, 5-32 chars
    if (!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(username)) return null;
    if (!messageId || !/^\d+$/.test(messageId)) return null;

    return {
      username,
      messageId: parseInt(messageId, 10),
      isPrivate: false,
    };
  } catch (e) {
    return null;
  }
};

/**
 * Parses a Telegram topic URL and extracts channel ID and topic ID.
 *
 * Supported formats:
 * - https://t.me/c/2209905090/22879  → Private channel topic (channelId: 2209905090, topicId: 22879)
 *
 * Note: This is specifically for topic URLs where the second number is the topic ID,
 * not a message ID. Use this when you know you're dealing with a topic link.
 *
 * @param {string} url - The Telegram URL to parse
 * @returns {Object|null} Parsed result with channelId and topicId. Null if invalid.
 */
const parseTopicUrl = (url) => {
  if (!url || typeof url !== "string") return null;

  try {
    const urlObj = new URL(url);

    // Must be a t.me URL
    if (!urlObj.hostname.endsWith("t.me")) return null;

    const pathParts = urlObj.pathname.split("/").filter(Boolean);

    // Topic URL format: /c/channelId/topicId
    if (pathParts.length < 3 || pathParts[0] !== "c") return null;

    const channelId = pathParts[1];
    const topicId = pathParts[2];

    if (!channelId || !/^\d+$/.test(channelId)) return null;
    if (!topicId || !/^\d+$/.test(topicId)) return null;

    return {
      channelId: parseInt(channelId, 10),
      topicId: parseInt(topicId, 10),
      isPrivate: true,
    };
  } catch (e) {
    return null;
  }
};

/**
 * Extracts all Telegram message URLs from a message's text and entities.
 *
 * @param {Object} message - The Telegram message object
 * @returns {string[]} Array of Telegram URLs found in the message
 */
const extractTelegramLinksFromMessage = (message) => {
  const links = new Set();

  if (!message) return [];

  const text = message.message || "";
  const entities = message.entities || [];

  // Extract URLs from entities
  for (const entity of entities) {
    // MessageEntityTextUrl - hyperlinks with custom text
    if (entity.className === "MessageEntityTextUrl" && entity.url) {
      if (isTelegramMessageUrl(entity.url)) {
        links.add(entity.url);
      }
    }

    // MessageEntityUrl - plain URLs in text
    if (entity.className === "MessageEntityUrl") {
      const url = text.substring(entity.offset, entity.offset + entity.length);
      if (isTelegramMessageUrl(url)) {
        links.add(url);
      }
    }
  }

  // Also scan text for any t.me URLs that might not be in entities
  const urlRegex = /https?:\/\/t\.me\/[^\s<>"']+/gi;
  const matches = text.match(urlRegex) || [];
  for (const match of matches) {
    if (isTelegramMessageUrl(match)) {
      links.add(match);
    }
  }

  return Array.from(links);
};

/**
 * Checks if a URL is a Telegram message URL (as opposed to a channel/user URL).
 *
 * @param {string} url - The URL to check
 * @returns {boolean} True if it's a message URL
 */
const isTelegramMessageUrl = (url) => {
  const parsed = parseTelegramUrl(url);
  return parsed !== null && typeof parsed.messageId === "number";
};

/**
 * Converts a private channel ID from URL format to Telegram API format.
 * Private channel IDs in URLs are positive, but API expects negative format with -100 prefix.
 *
 * @param {number} urlChannelId - The channel ID from the URL (positive)
 * @returns {number} The channel ID in Telegram API format
 */
const toApiChannelId = (urlChannelId) => {
  // Telegram API uses -100 prefix for channels/supergroups
  return -parseInt(`100${urlChannelId}`, 10);
};

module.exports = {
  parseTelegramUrl,
  parseTopicUrl,
  extractTelegramLinksFromMessage,
  isTelegramMessageUrl,
  toApiChannelId,
};
