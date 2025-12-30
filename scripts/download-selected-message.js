const path = require("path");
const { initAuth } = require("../modules/auth");
const { getMessageDetail, downloadMessageMedia } = require("../modules/messages");
const { getDialogName } = require("../modules/dialoges");
const { logMessage, getMediaPath, createChannelFolderName, getExportDirectory } = require("../utils/helper");
const { textInput } = require("../utils/input-helper");

class DownloadMessage {
  // -------------------------------
  // Accepts the following parameters:
  // - Channel ID
  // - Message ID(s) (separated by comma)
  // -------------------------------
  static description() {
    return "Download media from a messages";
  }

  async downloadMessage(client, channelId, dialogName, messageIds) {
    const folderName = createChannelFolderName(dialogName, channelId);
    const outputFolder = path.join(getExportDirectory(), folderName);
    
    const messageArr = await getMessageDetail(client, channelId, messageIds);
    for (const message of messageArr) {
      await downloadMessageMedia(
        client,
        message,
        getMediaPath(message, outputFolder),
        channelId
      );
    }
    logMessage.success("Done with downloading messages");
  }

  async handle() {
    let client;
    try {
      client = await initAuth();
      const channelId = await textInput("Please Enter Channel ID: ");
      const messageIdsText = await textInput(
        "Please Enter Message Id(s) (separated by comma): "
      );
      const messageIds = messageIdsText.split(",").map(Number);
      const dialogName = await getDialogName(client, channelId);

      await this.downloadMessage(client, channelId, dialogName, messageIds);
    } catch (error) {
      logMessage.error("An error occurred:", error);
    } finally {
      if (client) {
        await client.disconnect();
      }

      process.exit(0);
    }
  }
}

module.exports = DownloadMessage;
