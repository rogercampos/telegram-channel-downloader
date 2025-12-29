const cliProgress = require("cli-progress");

/**
 * Manages download progress bars for multiple concurrent downloads
 */
class ProgressManager {
  constructor() {
    this.multiBar = null;
    this.bars = new Map(); // downloadId -> { bar, totalBytes, filename }
  }

  /**
   * Initialize the multi-bar container
   */
  start() {
    this.multiBar = new cliProgress.MultiBar(
      {
        format:
          "{filename} [{bar}] {percentage}% | {downloaded}/{total}",
        clearOnComplete: false,
        hideCursor: true,
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
        forceRedraw: true,
      },
      cliProgress.Presets.shades_classic
    );
  }

  /**
   * Register a new download and create its progress bar
   * @param {string|number} downloadId - Unique identifier for this download
   * @param {string} filename - Name of the file being downloaded
   * @param {number} totalBytes - Total size in bytes (0 if unknown)
   * @returns {object} The created progress bar
   */
  startDownload(downloadId, filename, totalBytes) {
    if (!this.multiBar) {
      this.start();
    }

    const bar = this.multiBar.create(totalBytes || 100, 0, {
      filename: this.truncateFilename(filename, 30),
      downloaded: "0 B",
      total: totalBytes ? this.formatBytes(totalBytes) : "? B",
    });

    this.bars.set(downloadId, { bar, totalBytes, filename });
    return bar;
  }

  /**
   * Update progress for a download
   * @param {string|number} downloadId - Unique identifier for this download
   * @param {number} downloadedBytes - Bytes downloaded so far
   * @param {number} totalBytes - Total size in bytes
   */
  updateProgress(downloadId, downloadedBytes, totalBytes) {
    const entry = this.bars.get(downloadId);
    if (!entry) return;

    // Handle case where total wasn't known initially
    if (totalBytes && !entry.totalBytes) {
      entry.totalBytes = totalBytes;
      entry.bar.setTotal(totalBytes);
    }

    const total = entry.totalBytes || totalBytes || 100;

    entry.bar.update(downloadedBytes, {
      downloaded: this.formatBytes(downloadedBytes),
      total: this.formatBytes(total),
    });
  }

  /**
   * Mark download as complete
   * @param {string|number} downloadId - Unique identifier for this download
   * @param {boolean} success - Whether download completed successfully
   */
  completeDownload(downloadId, success = true) {
    const entry = this.bars.get(downloadId);
    if (!entry) return;

    if (success && entry.totalBytes) {
      entry.bar.update(entry.totalBytes, {
        downloaded: this.formatBytes(entry.totalBytes),
        total: this.formatBytes(entry.totalBytes),
      });
    }

    this.bars.delete(downloadId);
  }

  /**
   * Mark download as failed
   * @param {string|number} downloadId - Unique identifier for this download
   */
  failDownload(downloadId) {
    this.completeDownload(downloadId, false);
  }

  /**
   * Stop all bars and cleanup
   */
  stop() {
    if (this.multiBar) {
      this.multiBar.stop();
      this.multiBar = null;
    }
    this.bars.clear();
  }

  /**
   * Check if there are any active downloads
   * @returns {boolean}
   */
  hasActiveDownloads() {
    return this.bars.size > 0;
  }

  /**
   * Format bytes into human-readable string
   * @param {number} bytes - Number of bytes
   * @returns {string} Formatted string (e.g., "1.5 MB")
   */
  formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const value = bytes / Math.pow(k, i);

    return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }

  /**
   * Truncate filename to fit display width
   * @param {string} name - Original filename
   * @param {number} maxLen - Maximum length
   * @returns {string} Truncated filename with padding
   */
  truncateFilename(name, maxLen) {
    if (!name) return "unknown".padEnd(maxLen);

    if (name.length <= maxLen) {
      return name.padEnd(maxLen);
    }

    // Keep extension visible
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
    const maxNameLen = maxLen - ext.length - 3; // 3 for "..."

    if (maxNameLen > 0) {
      return name.slice(0, maxNameLen) + "..." + ext;
    }

    return name.slice(0, maxLen - 3) + "...";
  }
}

module.exports = ProgressManager;
