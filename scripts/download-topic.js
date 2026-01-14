"use strict";

const fs = require("fs");
const path = require("path");
const { Api } = require("telegram");
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
  sanitizeFolderName,
  getExportDirectory,
} = require("../utils/helper");
const {
  updateLastSelection,
  getLastSelection,
} = require("../utils/file-helper");
const { parseTopicUrl, toApiChannelId } = require("../utils/telegram-url");
const logger = require("../utils/logger");
const ProgressManager = require("../utils/progress");
const { downloadOptionInput } = require("../utils/input-helper");

const MAX_PARALLEL_DOWNLOAD = 3;
const MESSAGE_LIMIT = 50;
const ITERATION_WAIT_SECONDS = 3;

/**
 * Downloads media from a Telegram topic/thread.
 *
 * Usage:
 *   node cli.js download-topic --url="https://t.me/c/2209905090/22879"
 *   node cli.js download-topic --url="https://t.me/c/2209905090/22879" --from_date=01/12/2024
 */
class DownloadTopic {
  constructor() {
    this.outputFolder = null;
    this.downloadableFiles = null;
    this.fromDate = null;
    this.untilDate = null;
    this.exportPath = getExportDirectory();
    this.client = null;
    this.topicId = null;
    this.channelId = null;
    this.folderName = null;
  }

  static description() {
    return "Download all media from a topic/thread within a channel";
  }

  static help() {
    return `
Usage: node cli.js download-topic --url="<topic-url>" [options]

Downloads all media from a Telegram topic/thread (forum topic).

Options:
  --url          The Telegram topic URL (required)
                 Example: https://t.me/c/2209905090/22879
  --from_date    Only download messages from this date onwards (DD/MM/YYYY or DD/MM/YYYY HH:MM)
  --until_date   Only download messages until this date (DD/MM/YYYY or DD/MM/YYYY HH:MM)

Examples:
  node cli.js download-topic --url="https://t.me/c/2209905090/22879"
  node cli.js download-topic --url="https://t.me/c/2209905090/22879" --from_date=01/12/2024
  node cli.js download-topic --url="https://t.me/c/2209905090/22879" --from_date=01/12/2024 --until_date=31/12/2024
    `.trim();
  }

  hasMedia(message) {
    return Boolean(message.media);
  }

  isWithinDateRange(message) {
    const msgDate = message.date;
    if (this.fromDate && msgDate < this.fromDate) return false;
    if (this.untilDate && msgDate > this.untilDate) return false;
    return true;
  }

  canDownload(message) {
    if (!this.hasMedia(message)) return false;

    const hasDocument = Boolean(message.media.document);
    const hasPhoto = Boolean(message.media.photo);
    if (!hasDocument && !hasPhoto) return false;

    if (!this.isWithinDateRange(message)) return false;

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

  recordMessages(messages) {
    const filePath = path.join(this.outputFolder, "all_message.json");
    if (!fs.existsSync(this.outputFolder)) {
      fs.mkdirSync(this.outputFolder, { recursive: true });
    }
    const data = messages.map((msg) => {
      let messageText = msg.message || "";
      if (msg.entities && msg.entities.length > 0) {
        msg.entities.sort((a, b) => b.offset - a.offset);
        msg.entities.forEach((entity) => {
          if (entity.className === "MessageEntityTextUrl") {
            const url = entity.url;
            const linkText = messageText.substring(
              entity.offset,
              entity.offset + entity.length
            );
            messageText =
              messageText.substring(0, entity.offset) +
              `<a href="${url}">${linkText}</a>` +
              messageText.substring(entity.offset + entity.length);
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

  async getChannelDisplayName(channelId) {
    try {
      const entity = await this.client.getEntity(channelId);
      return entity.title || entity.username || String(channelId);
    } catch (err) {
      return String(channelId);
    }
  }

  async getTopicTitle(topicId) {
    try {
      const result = await this.client.invoke(
        new Api.channels.GetForumTopics({
          channel: await this.client.getInputEntity(this.channelId),
          limit: 100,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
        })
      );

      const topic = result.topics.find((t) => t.id === topicId);
      if (topic && topic.title) {
        return topic.title;
      }
      return null;
    } catch (err) {
      logger.warn(`Could not fetch topic title: ${err.message}`);
      return null;
    }
  }

  getMessageOffset() {
    const lastSelection = getLastSelection(this.folderName);
    return lastSelection.messageOffsetId || 0;
  }

  async downloadTopic(offsetMsgId = 0) {
    try {
      const messages = await getMessages(
        this.client,
        this.channelId,
        MESSAGE_LIMIT,
        offsetMsgId,
        this.topicId
      );

      if (!messages.length) {
        logger.info("No more messages to download");
        return;
      }

      const ids = messages.map((m) => m.id);
      const details = await getMessageDetail(this.client, this.channelId, ids);
      const progressManager = new ProgressManager();

      const downloadableMessages = details.filter((msg) =>
        this.canDownload(msg)
      );

      if (downloadableMessages.length > 0) {
        progressManager.start();

        for (
          let i = 0;
          i < downloadableMessages.length;
          i += MAX_PARALLEL_DOWNLOAD
        ) {
          const batch = downloadableMessages.slice(i, i + MAX_PARALLEL_DOWNLOAD);

          const results = await Promise.all(
            batch.map((msg) =>
              downloadMessageMedia(
                this.client,
                msg,
                getMediaPath(msg, this.outputFolder),
                this.channelId,
                progressManager
              )
            )
          );

          const allSucceeded = results.every((success) => success);

          if (allSucceeded) {
            const oldestInBatch = batch[batch.length - 1];
            updateLastSelection(this.folderName, {
              messageOffsetId: oldestInBatch.id,
            });
          } else {
            progressManager.stop();
            logger.warn("Some downloads failed, stopping to retry on next run");
            return;
          }
        }

        progressManager.stop();
      }

      this.recordMessages(details);

      const oldestMessage = messages[messages.length - 1];
      if (this.fromDate && oldestMessage.date < this.fromDate) {
        logger.info("Reached messages older than from_date, stopping");
        return;
      }

      await wait(ITERATION_WAIT_SECONDS);
      await this.downloadTopic(messages[messages.length - 1].id);
    } catch (err) {
      logger.error("An error occurred:");
      console.error(err);
    }
  }

  async handle(options = {}) {
    await wait(1);

    // Validate URL
    const url = options.url;
    if (!url) {
      logger.error("URL is required. Use --url=\"https://t.me/c/channelId/topicId\"");
      logger.info("Run with --help for usage information");
      process.exit(1);
    }

    // Parse the topic URL
    const parsed = parseTopicUrl(url);
    if (!parsed) {
      logger.error(`Invalid topic URL: ${url}`);
      logger.info("Expected format: https://t.me/c/channelId/topicId");
      process.exit(1);
    }

    this.topicId = parsed.topicId;
    this.channelId = toApiChannelId(parsed.channelId);

    // Parse date filters
    if (options.from_date) {
      this.fromDate = parseDateString(options.from_date, false);
      if (!this.fromDate) {
        logger.error(
          `Invalid from_date format: "${options.from_date}". Expected DD/MM/YYYY or DD/MM/YYYY HH:MM`
        );
        process.exit(1);
      }
      logger.info(`Filtering messages from: ${options.from_date}`);
    }

    if (options.until_date) {
      this.untilDate = parseDateString(options.until_date, true);
      if (!this.untilDate) {
        logger.error(
          `Invalid until_date format: "${options.until_date}". Expected DD/MM/YYYY or DD/MM/YYYY HH:MM`
        );
        process.exit(1);
      }
      logger.info(`Filtering messages until: ${options.until_date}`);
    }

    if (this.fromDate && this.untilDate && this.fromDate > this.untilDate) {
      logger.error("from_date cannot be after until_date");
      process.exit(1);
    }

    try {
      logger.info("Connecting to Telegram...");
      this.client = await initAuth();

      // Get channel and topic names for folder
      const channelName = await this.getChannelDisplayName(this.channelId);
      const topicTitle = await this.getTopicTitle(this.topicId);

      // Use topic title for folder name, fallback to channel name + topic ID
      let folderDisplayName;
      if (topicTitle) {
        folderDisplayName = sanitizeFolderName(topicTitle) || `topic_${parsed.topicId}`;
      } else {
        const sanitizedChannel = sanitizeFolderName(channelName) || `channel_${parsed.channelId}`;
        folderDisplayName = `${sanitizedChannel}_topic_${parsed.topicId}`;
      }

      this.folderName = `topic_${folderDisplayName}`;
      this.outputFolder = path.join(this.exportPath, this.folderName);

      if (!fs.existsSync(this.outputFolder)) {
        fs.mkdirSync(this.outputFolder, { recursive: true });
      }

      logger.info(`Channel: ${channelName}`);
      logger.info(`Topic: ${topicTitle || `ID ${this.topicId}`}`);
      logger.info(`Output folder: ${this.outputFolder}`);

      // Get downloadable file types
      this.downloadableFiles = await downloadOptionInput();

      const messageOffsetId = this.getMessageOffset();

      logger.info(`Downloading media from topic "${topicTitle || this.topicId}"...`);
      await this.downloadTopic(messageOffsetId);

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

module.exports = DownloadTopic;
