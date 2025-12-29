const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { circularStringify, wait } = require("../utils/helper");

const MAX_RETRIES = 5;
const RETRY_DELAYS = [5, 15, 30, 60, 120]; // seconds

const getMessages = async (client, channelId, limit = 10, offsetId = 0) => {
  if (!client || !channelId) {
    throw new Error("Client and channelId are required");
  }

  try {
    const result = await client.getMessages(channelId, { limit, offsetId });
    return result;
  } catch (error) {
    throw new Error(`Failed to get messages: ${error.message}`);
  }
};

const getMessageDetail = async (client, channelId, messageIds) => {
  if (!client || !channelId || !messageIds) {
    throw new Error("Client, channelId, and messageIds are required");
  }

  try {
    const result = await client.getMessages(channelId, { ids: messageIds });
    return result;
  } catch (error) {
    throw new Error(`Failed to get message details: ${error.message}`);
  }
};

const downloadMessageMedia = async (client, message, mediaPath, retryCount = 0) => {
  try {
    if (!client || !message || !mediaPath) {
      logger.error("Client, message, and mediaPath are required");
      return false;
    }

    if (message.media) {
      if (message.media.webpage) {
        const url = message.media.webpage.url;
        if (url) {
          const urlPath = path.join(mediaPath, `../${message.id}_url.txt`);
          fs.writeFileSync(urlPath, url);
        }

        mediaPath = path.join(
          mediaPath,
          `../${message?.media?.webpage?.id}_image.jpeg`
        );
      }

      if (message.media.poll) {
        const pollPath = path.join(mediaPath, `../${message.id}_poll.json`);
        fs.writeFileSync(
          pollPath,
          circularStringify(message.media.poll, null, 2)
        );
      }

      await client.downloadMedia(message, {
        outputFile: mediaPath,
        progressCallback: (downloaded, total) => {
          const name = path.basename(mediaPath);
          if (total === downloaded) {
            logger.success(`File ${name} downloaded successfully`);
          }
        },
      });

      return true;
    } else {
      logger.error("No media found in the message");
      return false;
    }

  } catch (err) {
    const errorMessage = err.errorMessage || err.message || "";
    const errorCode = err.code || 0;

    // Check if we should retry (timeout, flood wait, or server errors)
    const isRetryable =
      errorCode === -503 || // Timeout
      errorCode === 420 ||  // Flood wait
      errorMessage.includes("Timeout") ||
      errorMessage.includes("FLOOD") ||
      errorMessage.includes("timeout") ||
      (errorCode >= 500 && errorCode < 600); // Server errors

    if (isRetryable && retryCount < MAX_RETRIES) {
      // Extract wait time from FloodWaitError if available, otherwise use exponential backoff
      let waitTime = RETRY_DELAYS[retryCount];
      if (err.seconds) {
        waitTime = err.seconds + 1; // Add 1 second buffer
      }

      const fileName = path.basename(mediaPath);
      logger.warn(`Download failed for ${fileName}, retrying in ${waitTime}s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      await wait(waitTime);
      return downloadMessageMedia(client, message, mediaPath, retryCount + 1);
    }

    logger.error(`Error downloading message ${message.id}: ${errorMessage}`);
    console.error(err);
    return false;
  }
};

module.exports = {
  getMessages,
  getMessageDetail,
  downloadMessageMedia,
};
