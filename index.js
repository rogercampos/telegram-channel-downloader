const ChannelDownloader = require("./scripts/download-channel");
const channelDownloader = new ChannelDownloader();

const channelId = "";
const downloadableFiles = {
  image: true,
  video: true,
  audio: true,
  sticker: true,
  document: true,
};

(async () => {
  try {
    await channelDownloader.handle({ channelId, downloadableFiles });
  } catch (err) {
    console.error(err);
  }
})();
