"use strict";
const fs = require("fs");
const path = require("path");
const { initAuth } = require("../modules/auth");
const {
  getMessages,
  getMessageDetail,
  downloadMessageMedia,
} = require("../modules/messages");
const {
  getMediaType,
  getMediaPath,
  checkFileExist,
  appendToJSONArrayFile,
  wait,
  parseDateString,
  createChannelFolderName,
  getExportDirectory,
} = require("../utils/helper");
const {
  updateLastSelection,
  getLastSelection,
} = require("../utils/file-helper");
const logger = require("../utils/logger");
const ProgressManager = require("../utils/progress");
const { getDialogName, getAllDialogs } = require("../modules/dialoges");
const {
  downloadOptionInput,
  selectInput,
} = require("../utils/input-helper");

const MAX_PARALLEL_DOWNLOAD = 3;
const MESSAGE_LIMIT = 50;
const BATCH_WAIT_SECONDS = 8;
const ITERATION_WAIT_SECONDS = 3;

/**
 * Handles downloading media from a Telegram channel
 */
class DownloadChannel {
  constructor() {
    this.outputFolder = null;
    this.downloadableFiles = null;
    this.fromDate = null;  // Unix timestamp (seconds)
    this.untilDate = null; // Unix timestamp (seconds)
    this.exportPath = getExportDirectory();
  }

  static description() {
    return "Download all media from a channel";
  }

  /**
   * Checks if a message contains media
   * @param {Object} message The Telegram message object
   */
  hasMedia(message) {
    return Boolean(message.media);
  }

  /**
   * Checks if a message date is within the specified date range
   * @param {Object} message The Telegram message object with .date property (Unix timestamp)
   * @returns {boolean} True if message is within range
   */
  isWithinDateRange(message) {
    const msgDate = message.date; // Unix timestamp in seconds
    if (this.fromDate && msgDate < this.fromDate) return false;
    if (this.untilDate && msgDate > this.untilDate) return false;
    return true;
  }

  /**
   * Determines if a message's media should be downloaded
   * @param {Object} message The Telegram message object
   */
  canDownload(message) {
    if (!this.hasMedia(message)) return false;

    // Only support document and photo media types
    const hasDocument = Boolean(message.media.document);
    const hasPhoto = Boolean(message.media.photo);
    if (!hasDocument && !hasPhoto) return false;

    if (!this.isWithinDateRange(message)) return false;

    // Check if file exists BEFORE calling getMediaPath() to avoid log side effects
    const fileExists = checkFileExist(message, this.outputFolder);
    if (fileExists) return false;

    const mediaType = getMediaType(message);
    const mediaPath = getMediaPath(message, this.outputFolder);
    const extension = path.extname(mediaPath).toLowerCase().replace(".", "");
    const allowed =
      this.downloadableFiles?.[mediaType] ||
      this.downloadableFiles?.[extension] ||
      this.downloadableFiles?.all;

    return allowed;
  }

  /**
   * Records messages to a JSON file
   * @param {Array} messages The message objects
   */
  recordMessages(messages) {
    const filePath = path.join(this.outputFolder, "all_message.json");
    if (!fs.existsSync(this.outputFolder)) {
      fs.mkdirSync(this.outputFolder, {recursive: true});
    }
    const data = messages.map((msg) => {
      let messageText = msg.message || "";
      if (msg.entities && msg.entities.length > 0) {
        msg.entities.sort((a, b) => b.offset - a.offset);
        msg.entities.forEach((entity) => {
          if (entity.className === "MessageEntityTextUrl") {
            const url = entity.url;
            const linkText = messageText.substring(entity.offset, entity.offset + entity.length);
            messageText = messageText.substring(0, entity.offset) + `<a href="${url}">${linkText}</a>` + messageText.substring(entity.offset + entity.length);
          }
        });
      }
      return {
        id: msg.id,
        message: messageText,
        date: msg.date,
        out: msg.out,
        hasMedia: !!msg.media,
        sender: msg.fromId?.userId || msg.peerId?.userId,
        mediaType: this.hasMedia(msg) ? getMediaType(msg) : undefined,
        mediaPath: this.hasMedia(msg)
            ? getMediaPath(msg, this.outputFolder)
            : undefined,
        mediaName: this.hasMedia(msg)
            ? path.basename(getMediaPath(msg, this.outputFolder))
            : undefined,
      };
    });
    appendToJSONArrayFile(filePath, data);
  }

  /**
   * Recursively fetches and downloads all available media from the channel
   * @param {Object} client The Telegram client instance
   * @param {Number} channelId The channel ID
   * @param {String} dialogName The channel/dialog name
   * @param {Number} offsetMsgId The message offset
   */
  async downloadChannel(client, channelId, dialogName, offsetMsgId = 0) {
    try {
      const folderName = createChannelFolderName(dialogName, channelId);
      this.outputFolder = path.join(this.exportPath, folderName);
      const messages = await getMessages(
        client,
        channelId,
        MESSAGE_LIMIT,
        offsetMsgId
      );
      if (!messages.length) {
        logger.info("No more messages to download");
        return;
      }
      const ids = messages.map((m) => m.id);
      const details = await getMessageDetail(client, channelId, ids);
      const progressManager = new ProgressManager();

      // Filter to only downloadable messages
      const downloadableMessages = details.filter((msg) => this.canDownload(msg));

      if (downloadableMessages.length > 0) {
        progressManager.start();

        // Process in batches of MAX_PARALLEL_DOWNLOAD
        for (let i = 0; i < downloadableMessages.length; i += MAX_PARALLEL_DOWNLOAD) {
          const batch = downloadableMessages.slice(i, i + MAX_PARALLEL_DOWNLOAD);

          // Download all in batch concurrently
          const results = await Promise.all(
            batch.map((msg) =>
              downloadMessageMedia(
                client,
                msg,
                getMediaPath(msg, this.outputFolder),
                channelId,
                progressManager
              )
            )
          );

          // Check if all downloads in this batch succeeded
          const allSucceeded = results.every((success) => success);

          if (allSucceeded) {
            // Update offset to the oldest message in this batch
            const oldestInBatch = batch[batch.length - 1];
            updateLastSelection(folderName, {
              messageOffsetId: oldestInBatch.id,
            });
          } else {
            // Stop processing - don't advance offset past failed downloads
            progressManager.stop();
            logger.warn("Some downloads failed, stopping to retry on next run");
            return;
          }
        }

        progressManager.stop();
      }
      this.recordMessages(details);

      // Early exit optimization: Messages are in reverse chronological order (newest first).
      // If the oldest message in this batch is older than from_date, stop fetching more.
      const oldestMessage = messages[messages.length - 1];
      if (this.fromDate && oldestMessage.date < this.fromDate) {
        logger.info("Reached messages older than from_date, stopping");
        return;
      }

      await wait(ITERATION_WAIT_SECONDS);
      await this.downloadChannel(
        client,
        channelId,
        dialogName,
        messages[messages.length - 1].id
      );
    } catch (err) {
      logger.error("An error occurred:");
      console.error(err);
    }
  }

  async configureDownload(options, client) {
    let channelId = options.channelId;
    let downloadableFiles = options.downloadableFiles;
    if (!channelId) {
      logger.info("Please select a channel to download media from");
      const allChannels = await getAllDialogs(client);
      const channelOptions = allChannels.map((d) => ({
        name: d.name,
        value: d.id,
      }));

      const selectedChannel = await selectInput(
        "Please select a channel",
        channelOptions
      );
      channelId = selectedChannel;
    }
    if (!downloadableFiles) downloadableFiles = await downloadOptionInput();

    this.downloadableFiles = downloadableFiles;
    return { channelId };
  }

  /**
   * Gets the message offset for a channel from its tracking file
   * @param {string} folderName The channel folder name
   * @returns {number} The message offset ID
   */
  getMessageOffset(folderName) {
    const lastSelection = getLastSelection(folderName);
    return lastSelection.messageOffsetId || 0;
  }

  /**
   * Main entry point: initializes auth, sets up output folder, and starts download
   */
  async handle(options = {}) {
    let client;
    await wait(1);

    // Parse date filters
    if (options.from_date) {
      this.fromDate = parseDateString(options.from_date, false); // Start of day
      if (!this.fromDate) {
        logger.error(`Invalid from_date format: "${options.from_date}". Expected DD/MM/YYYY`);
        process.exit(1);
      }
      logger.info(`Filtering messages from: ${options.from_date}`);
    }

    if (options.until_date) {
      this.untilDate = parseDateString(options.until_date, true); // End of day
      if (!this.untilDate) {
        logger.error(`Invalid until_date format: "${options.until_date}". Expected DD/MM/YYYY`);
        process.exit(1);
      }
      logger.info(`Filtering messages until: ${options.until_date}`);
    }

    // Validate date range
    if (this.fromDate && this.untilDate && this.fromDate > this.untilDate) {
      logger.error("from_date cannot be after until_date");
      process.exit(1);
    }

    try {
      client = await initAuth();
      const { channelId } = await this.configureDownload(options, client);

      const dialogName = await getDialogName(client, channelId);
      const folderName = createChannelFolderName(dialogName, channelId);
      const messageOffsetId = this.getMessageOffset(folderName);

      logger.info(`Downloading media from channel ${dialogName}`);
      await this.downloadChannel(client, channelId, dialogName, messageOffsetId);
    } catch (err) {
      logger.error("An error occurred:");
      console.error(err);
    } finally {
      if (client) await client.disconnect();
      process.exit(0);
    }
  }
}

module.exports = DownloadChannel;
