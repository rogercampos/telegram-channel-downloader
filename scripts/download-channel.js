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

const MAX_PARALLEL_DOWNLOAD = 5;
const MESSAGE_LIMIT = 10;
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

    const exportPath = path.resolve(process.cwd(), "./export");
    if (!fs.existsSync(exportPath)) {
      fs.mkdirSync(exportPath);
    }
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
    if (!this.isWithinDateRange(message)) return false;
    const mediaType = getMediaType(message);
    const mediaPath = getMediaPath(message, this.outputFolder);
    const fileExists = checkFileExist(message, this.outputFolder);
    const extension = path.extname(mediaPath).toLowerCase().replace(".", "");
    const allowed =
      this.downloadableFiles?.[mediaType] ||
      this.downloadableFiles?.[extension] ||
      this.downloadableFiles?.all;

    return allowed && !fileExists;
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
      this.outputFolder = path.join(
        process.cwd(),
        "export",
        folderName
      );
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

        // Concurrent pool: always maintain MAX_PARALLEL_DOWNLOAD active downloads
        const activeDownloads = new Set();
        let index = 0;

        const startNextDownload = () => {
          if (index >= downloadableMessages.length) return null;

          const msg = downloadableMessages[index++];
          const downloadPromise = downloadMessageMedia(
            client,
            msg,
            getMediaPath(msg, this.outputFolder),
            progressManager
          ).finally(() => {
            activeDownloads.delete(downloadPromise);
          });

          activeDownloads.add(downloadPromise);
          return downloadPromise;
        };

        // Start initial batch of downloads
        while (activeDownloads.size < MAX_PARALLEL_DOWNLOAD && index < downloadableMessages.length) {
          startNextDownload();
        }

        // As each download completes, start a new one
        while (activeDownloads.size > 0) {
          await Promise.race(activeDownloads);
          // Start new downloads to maintain pool size
          while (activeDownloads.size < MAX_PARALLEL_DOWNLOAD && index < downloadableMessages.length) {
            startNextDownload();
          }
        }

        progressManager.stop();
      }
      this.recordMessages(details);
      updateLastSelection({
        messageOffsetId: messages[messages.length - 1].id,
      });

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
      const options = allChannels.map((d) => ({
        name: d.name,
        value: d.id,
      }));

      const selectedChannel = await selectInput(
        "Please select a channel",
        options
      );
      channelId = selectedChannel;
    }
    if (!downloadableFiles) downloadableFiles = await downloadOptionInput();

    this.downloadableFiles = downloadableFiles;

    const lastSelection = getLastSelection();
    let messageOffsetId = lastSelection.messageOffsetId || 0;

    if (Number(lastSelection.channelId) !== Number(channelId)) {
      messageOffsetId = 0;
    }
    updateLastSelection({ messageOffsetId, channelId });
    return { channelId, messageOffsetId };
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
      const { channelId, messageOffsetId } = await this.configureDownload(
        options,
        client
      );

      const dialogName = await getDialogName(client, channelId);
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
