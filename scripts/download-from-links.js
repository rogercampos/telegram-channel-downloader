"use strict";

const fs = require("fs");
const path = require("path");
const { initAuth } = require("../modules/auth");
const { getMessageDetail, downloadMessageMedia } = require("../modules/messages");
const {
  getMediaType,
  getMediaPath,
  checkFileExist,
  wait,
  sanitizeFolderName,
  getExportDirectory,
  MEDIA_TYPES,
} = require("../utils/helper");
const {
  parseTelegramUrl,
  extractTelegramLinksFromMessage,
  toApiChannelId,
} = require("../utils/telegram-url");
const logger = require("../utils/logger");
const ProgressManager = require("../utils/progress");
const { textInput } = require("../utils/input-helper");

const MAX_PARALLEL_DOWNLOAD = 3;

/**
 * Downloads videos from messages linked within a source Telegram message.
 *
 * Usage:
 *   node cli.js download-from-links --url="https://t.me/c/2623426951/3/17039"
 *
 * The source message should contain links to other Telegram messages.
 * This script will extract those links and download videos from each linked message.
 */
class DownloadFromLinks {
  constructor() {
    this.outputFolder = null;
    this.exportPath = getExportDirectory();
    this.client = null;
  }

  static description() {
    return "Download videos from messages linked within a source message";
  }

  static help() {
    return `
Usage: node cli.js download-from-links --url="<telegram-url>"

Downloads videos from all Telegram messages that are linked within a source message.

Options:
  --url    The Telegram message URL containing links to other messages
           Example: https://t.me/c/2623426951/3/17039

Examples:
  node cli.js download-from-links --url="https://t.me/c/2623426951/3/17039"
  node cli.js download-from-links  (will prompt for URL)
    `.trim();
  }

  /**
   * Resolves a channel entity from either a numeric ID or username.
   * @param {Object} parsed - Parsed URL result with channelId or username
   * @returns {Promise<Object>} The channel entity
   */
  async resolveChannelEntity(parsed) {
    if (parsed.isPrivate) {
      // Private channel - convert URL ID to API format
      return toApiChannelId(parsed.channelId);
    } else {
      // Public channel - resolve username to entity
      try {
        const entity = await this.client.getEntity(parsed.username);
        return entity;
      } catch (err) {
        logger.error(`Failed to resolve username @${parsed.username}: ${err.message}`);
        return null;
      }
    }
  }

  /**
   * Gets a display name for a channel entity.
   * @param {Object|number} entity - The channel entity or ID
   * @param {Object} parsed - Parsed URL result
   * @returns {Promise<string>} The channel name or ID as fallback
   */
  async getChannelDisplayName(entity, parsed) {
    try {
      if (typeof entity === "number") {
        // For private channels, try to get entity info
        const fullEntity = await this.client.getEntity(entity);
        return fullEntity.title || fullEntity.username || String(parsed.channelId);
      }
      return entity.title || entity.username || String(parsed.channelId || parsed.username);
    } catch (err) {
      // Fallback to ID or username
      return String(parsed.channelId || parsed.username);
    }
  }

  /**
   * Checks if a message contains a downloadable video.
   * @param {Object} message - The Telegram message object
   * @returns {boolean}
   */
  isDownloadableVideo(message) {
    if (!message || !message.media) return false;

    const hasDocument = Boolean(message.media.document);
    const hasPhoto = Boolean(message.media.photo);

    if (!hasDocument && !hasPhoto) return false;

    const mediaType = getMediaType(message);
    return mediaType === MEDIA_TYPES.VIDEO;
  }

  /**
   * Creates the output folder for downloads.
   * @param {string} sourceName - Name derived from source message/channel
   * @param {number} sourceMessageId - The source message ID
   * @returns {string} The output folder path
   */
  createOutputFolder(sourceName, sourceMessageId) {
    const sanitizedName = sanitizeFolderName(sourceName) || `message_${sourceMessageId}`;
    const folderName = `linked_${sanitizedName}_${sourceMessageId}`;
    const outputFolder = path.join(this.exportPath, folderName);

    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    return outputFolder;
  }

  /**
   * Downloads videos from the linked messages.
   * @param {Array<Object>} linkedMessages - Array of { entity, message } objects
   * @param {ProgressManager} progressManager - Progress tracker
   */
  async downloadVideos(linkedMessages, progressManager) {
    // Filter to only downloadable videos
    const downloadable = linkedMessages.filter(({ message }) => {
      if (!this.isDownloadableVideo(message)) return false;

      // Check if already downloaded
      return !checkFileExist(message, this.outputFolder);
    });

    if (downloadable.length === 0) {
      logger.info("No new videos to download");
      return;
    }

    logger.info(`Found ${downloadable.length} video(s) to download`);
    progressManager.start();

    // Process in batches
    for (let i = 0; i < downloadable.length; i += MAX_PARALLEL_DOWNLOAD) {
      const batch = downloadable.slice(i, i + MAX_PARALLEL_DOWNLOAD);

      await Promise.all(
        batch.map(async ({ entity, message }) => {
          const mediaPath = getMediaPath(message, this.outputFolder);
          // Pass entity as channelId for potential file reference refresh
          const channelId = typeof entity === "number" ? entity : entity.id;
          await downloadMessageMedia(this.client, message, mediaPath, channelId, progressManager);
        })
      );
    }

    progressManager.stop();
  }

  /**
   * Main entry point.
   * @param {Object} options - CLI options
   */
  async handle(options = {}) {
    try {
      // Get URL from options or prompt
      let url = options.url;
      if (!url) {
        url = await textInput("Enter the Telegram message URL containing links:");
      }

      if (!url) {
        logger.error("No URL provided");
        process.exit(1);
      }

      // Parse the source URL
      const sourceParsed = parseTelegramUrl(url);
      if (!sourceParsed) {
        logger.error(`Invalid Telegram URL: ${url}`);
        logger.info("Expected format: https://t.me/c/channelId/messageId or https://t.me/username/messageId");
        process.exit(1);
      }

      logger.info("Connecting to Telegram...");
      this.client = await initAuth();

      // Resolve source channel
      const sourceEntity = await this.resolveChannelEntity(sourceParsed);
      if (!sourceEntity) {
        logger.error("Failed to resolve source channel");
        process.exit(1);
      }

      // Fetch source message
      logger.info(`Fetching source message ${sourceParsed.messageId}...`);
      const sourceMessages = await getMessageDetail(this.client, sourceEntity, [sourceParsed.messageId]);

      if (!sourceMessages || !sourceMessages[0]) {
        logger.error("Could not fetch source message. Make sure you have access to this channel/message.");
        process.exit(1);
      }

      const sourceMessage = sourceMessages[0];

      // Extract Telegram links from source message
      const links = extractTelegramLinksFromMessage(sourceMessage);

      if (links.length === 0) {
        logger.warn("No Telegram message links found in the source message");
        process.exit(0);
      }

      logger.info(`Found ${links.length} link(s) in source message`);

      // Parse all links and group by channel
      const parsedLinks = links
        .map((link) => ({ link, parsed: parseTelegramUrl(link) }))
        .filter(({ parsed }) => parsed !== null);

      // Fetch messages from each link
      // If the linked message is not a video, also check the next message (messageId + 1)
      const linkedMessages = [];
      const processedMessageIds = new Set(); // Track by channel:messageId to avoid duplicates

      for (const { link, parsed } of parsedLinks) {
        // Deduplicate by channel+message combination
        const baseKey = `${parsed.channelId || parsed.username}:${parsed.messageId}`;
        if (processedMessageIds.has(baseKey)) continue;
        processedMessageIds.add(baseKey);

        try {
          const entity = await this.resolveChannelEntity(parsed);
          if (!entity) {
            logger.warn(`Skipping ${link} - could not resolve channel`);
            continue;
          }

          // Fetch the linked message and the next few messages (some may be missing or non-video)
          const lookAhead = 5; // Check up to 5 messages ahead
          const messageIds = Array.from({ length: lookAhead + 1 }, (_, i) => parsed.messageId + i);
          const messages = await getMessageDetail(this.client, entity, messageIds);

          if (!messages || messages.length === 0) {
            logger.warn(`Skipping ${link} - could not fetch message`);
            continue;
          }

          // Check if the linked message has a video
          const linkedMsg = messages.find(m => m && m.id === parsed.messageId);

          if (linkedMsg && this.isDownloadableVideo(linkedMsg)) {
            // Linked message has a video, use it
            linkedMessages.push({ entity, message: linkedMsg, link });
          } else {
            // Look for first video in the next messages
            const videoMsg = messages.find(m => m && m.id > parsed.messageId && this.isDownloadableVideo(m));

            if (videoMsg) {
              const videoKey = `${parsed.channelId || parsed.username}:${videoMsg.id}`;
              if (!processedMessageIds.has(videoKey)) {
                processedMessageIds.add(videoKey);
                linkedMessages.push({ entity, message: videoMsg, link });
                logger.info(`Link ${link} -> using message #${videoMsg.id} (contains video)`);
              }
            } else {
              logger.warn(`Skipping ${link} - no video found in linked message or next ${lookAhead} messages`);
            }
          }

          // Small delay between fetches to avoid rate limiting
          await wait(0.5);
        } catch (err) {
          logger.warn(`Skipping ${link} - ${err.message}`);
        }
      }

      if (linkedMessages.length === 0) {
        logger.warn("Could not fetch any linked messages");
        process.exit(0);
      }

      logger.info(`Successfully fetched ${linkedMessages.length} linked message(s)`);

      // Create output folder
      const sourceName = await this.getChannelDisplayName(sourceEntity, sourceParsed);
      this.outputFolder = this.createOutputFolder(sourceName, sourceParsed.messageId);
      logger.info(`Output folder: ${this.outputFolder}`);

      // Download videos
      const progressManager = new ProgressManager();
      await this.downloadVideos(linkedMessages, progressManager);

      logger.success("Done!");
    } catch (err) {
      logger.error(`An error occurred: ${err.message}`);
      console.error(err);
    } finally {
      if (this.client) {
        await this.client.disconnect();
      }
      process.exit(0);
    }
  }
}

module.exports = DownloadFromLinks;
