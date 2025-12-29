const path = require("path");
const logger = require("../utils/logger");
const { wait } = require("../utils/helper");
const { resumableDownload, getPartialFileSize, getPartialFilePath } = require("./resumable-download");

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

const downloadMessageMedia = async (client, message, mediaPath, progressManager = null, retryCount = 0) => {
  const downloadId = message.id;
  const filename = path.basename(mediaPath);

  try {
    if (!client || !message || !mediaPath) {
      logger.error("Client, message, and mediaPath are required");
      return false;
    }

    if (message.media) {
      // Only handle document and photo media types, skip others silently
      const hasDocument = Boolean(message.media.document);
      const hasPhoto = Boolean(message.media.photo);

      if (!hasDocument && !hasPhoto) {
        return false;
      }

      // Get total file size for progress tracking
      const totalBytes =
        message.media?.document?.size ||
        message.media?.photo?.sizes?.slice(-1)[0]?.size ||
        0;

      // Check for existing partial download to adjust initial progress
      const partialPath = getPartialFilePath(mediaPath);
      const existingBytes = getPartialFileSize(partialPath);

      // Register with progress manager if available (only on first attempt)
      if (progressManager && retryCount === 0) {
        progressManager.startDownload(downloadId, filename, totalBytes);
        // If resuming, update progress to show existing bytes
        if (existingBytes > 0) {
          progressManager.updateProgress(downloadId, existingBytes, totalBytes);
        }
      }

      // Use resumable download
      await resumableDownload(client, message, mediaPath, (downloaded, total) => {
        if (progressManager) {
          progressManager.updateProgress(downloadId, downloaded, total);
        }
        // Keep existing completion log for non-progress mode
        if (!progressManager && total > 0 && total === downloaded) {
          logger.success(`File ${filename} downloaded successfully`);
        }
      });

      // Mark complete
      if (progressManager) {
        progressManager.completeDownload(downloadId, true);
      }

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

      if (!progressManager) {
        logger.warn(`Download failed for ${filename}, retrying in ${waitTime}s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      }
      await wait(waitTime);
      return downloadMessageMedia(client, message, mediaPath, progressManager, retryCount + 1);
    }

    // Mark as failed in progress manager
    if (progressManager) {
      progressManager.failDownload(downloadId);
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
