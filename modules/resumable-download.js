const fs = require("fs");
const path = require("path");
const bigInt = require("big-integer");
const { Api } = require("telegram/tl");
const { iterDownload } = require("telegram/client/downloads");
const logger = require("../utils/logger");

const MIN_CHUNK_SIZE = 4096;
const DEFAULT_PART_SIZE_KB = 512; // 512KB chunks

/**
 * Get the partial file path for a media file
 * @param {string} mediaPath - The final destination path
 * @returns {string} Path with .partial extension
 */
const getPartialFilePath = (mediaPath) => {
  return mediaPath + ".partial";
};

/**
 * Get the size of a partial file, or 0 if it doesn't exist
 * @param {string} partialPath - Path to the partial file
 * @returns {number} Size in bytes, or 0
 */
const getPartialFileSize = (partialPath) => {
  try {
    if (fs.existsSync(partialPath)) {
      const stats = fs.statSync(partialPath);
      return stats.size;
    }
  } catch (err) {
    // If we can't read the file, start fresh
  }
  return 0;
};

/**
 * Format bytes to human-readable string
 * @param {number} bytes
 * @returns {string}
 */
const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
};

/**
 * Extract file location and metadata from a message's media
 * @param {Object} message - Telegram message object
 * @returns {Object|null} { inputLocation, dcId, fileSize, isPhoto } or null
 */
const extractFileInfo = (message) => {
  if (!message || !message.media) return null;

  const { media } = message;

  // Handle documents (videos, files, audio, etc.)
  if (media.document) {
    const doc = media.document;
    return {
      inputLocation: new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: "",
      }),
      dcId: doc.dcId,
      fileSize: doc.size ? bigInt(doc.size.toString()) : null,
      isPhoto: false,
    };
  }

  // Handle photos
  if (media.photo) {
    const photo = media.photo;
    // Get the largest photo size
    const sizes = photo.sizes || [];
    const largestSize = sizes
      .filter((s) => s.className === "PhotoSize" || s.className === "PhotoSizeProgressive")
      .sort((a, b) => {
        const aSize = a.size || (a.sizes ? Math.max(...a.sizes) : 0);
        const bSize = b.size || (b.sizes ? Math.max(...b.sizes) : 0);
        return bSize - aSize;
      })[0];

    if (!largestSize) return null;

    const fileSize = largestSize.size || (largestSize.sizes ? Math.max(...largestSize.sizes) : 0);

    return {
      inputLocation: new Api.InputPhotoFileLocation({
        id: photo.id,
        accessHash: photo.accessHash,
        fileReference: photo.fileReference,
        thumbSize: largestSize.type || "w",
      }),
      dcId: photo.dcId,
      fileSize: fileSize ? bigInt(fileSize) : null,
      isPhoto: true,
    };
  }

  return null;
};

/**
 * Download media with resume support
 * @param {TelegramClient} client - The Telegram client
 * @param {Object} message - The message containing media
 * @param {string} mediaPath - Destination file path
 * @param {Function} progressCallback - Optional callback (downloaded, total)
 * @returns {Promise<boolean>} True if successful
 */
const resumableDownload = async (client, message, mediaPath, progressCallback = null) => {
  const fileInfo = extractFileInfo(message);
  if (!fileInfo) {
    logger.error("Could not extract file info from message");
    return false;
  }

  const { inputLocation, dcId, fileSize } = fileInfo;
  const partialPath = getPartialFilePath(mediaPath);
  const filename = path.basename(mediaPath);

  // Check for existing partial download
  let existingSize = getPartialFileSize(partialPath);
  let offset = bigInt(existingSize);

  // If partial file is larger than or equal to total, something's wrong - delete it
  if (fileSize && existingSize >= fileSize.toJSNumber()) {
    logger.warn(`Partial file ${filename} is already complete or corrupted, restarting`);
    try {
      fs.unlinkSync(partialPath);
    } catch (e) {}
    existingSize = 0;
    offset = bigInt.zero;
  }

  // Log resume status
  if (existingSize > 0) {
    logger.info(`Resuming ${filename} from ${formatBytes(existingSize)}`);
  }

  // Ensure directory exists
  const dir = path.dirname(mediaPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Prepare msgData for file reference refresh (important for long downloads)
  const msgData = message.inputChat ? [message.inputChat, message.id] : undefined;

  // Calculate part size
  const partSizeKb = DEFAULT_PART_SIZE_KB;
  const partSize = partSizeKb * 1024;

  // Open file for writing (append mode if resuming)
  const writeStream = fs.createWriteStream(partialPath, {
    flags: existingSize > 0 ? "a" : "w",
  });

  let downloaded = bigInt(existingSize);
  const totalSize = fileSize || bigInt.zero;

  try {
    // Use iterDownload with offset for resumable download
    const downloadIter = iterDownload(client, {
      file: inputLocation,
      offset: offset,
      requestSize: partSize,
      fileSize: fileSize,
      dcId: dcId,
      msgData: msgData,
    });

    for await (const chunk of downloadIter) {
      // Write chunk to file
      await new Promise((resolve, reject) => {
        writeStream.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      downloaded = downloaded.add(chunk.length);

      // Call progress callback
      if (progressCallback) {
        progressCallback(
          downloaded.toJSNumber(),
          totalSize.toJSNumber()
        );
      }
    }

    // Close write stream
    await new Promise((resolve) => writeStream.end(resolve));

    // Rename partial file to final name
    fs.renameSync(partialPath, mediaPath);

    return true;
  } catch (err) {
    // Close write stream on error
    writeStream.end();

    // Don't delete partial file - we can resume later
    logger.error(`Download error for ${filename}: ${err.message}`);
    throw err;
  }
};

module.exports = {
  resumableDownload,
  getPartialFilePath,
  getPartialFileSize,
  extractFileInfo,
  formatBytes,
};
