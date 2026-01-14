# Telegram Channel Downloader

**Telegram Channel Downloader** is a Node.js application that allows users to download media files and messages in HTML and JSON formats from Telegram channels, groups, or users. This tool simplifies the process of archiving content from Telegram for offline viewing or storage.

## Sponsor the Project

<p>Support the project by buying me a coffee! Every contribution helps keep the project running.</p>
<a href="https://www.buymeacoffee.com/abhishekjnvk" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" alt="Buy Me A Coffee" style="height: 41px !important;width: 174px !important;box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;-webkit-box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;" ></a>

## Setup

To use the Telegram Channel Downloader, follow these steps:

1. **Create a Telegram App**: Go to [https://my.telegram.org/apps](https://my.telegram.org/apps) and create a new application.
2. **Get API Credentials**: After creating the app, copy the API ID and API Hash provided by Telegram.

### Configure `config.json`

3. In the root directory of the application, create a file named `config.json` and paste the following code:

    ```json
    {
        "apiId": "YOUR_API_ID",
        "apiHash": "YOUR_API_HASH",
        "sessionId": ""
    }
    ```

    Replace `YOUR_API_ID` and `YOUR_API_HASH` with the values obtained in step 2. Keep the `sessionId` blank for now; it will be updated automatically after logging in for the first time.

## Usage

Once the setup is complete, you can start using the Telegram Channel Downloader:

1. Install all dependencies using:  

    ```bash
    npm install
    ```

2. **Run the Script**: Open your terminal or command prompt and navigate to the directory where the Telegram Channel Downloader is located. Run the following command to start the script:

    ```bash
    npm start
    ```

3. **Login**: The script will prompt you to enter your phone number and the code sent to your phone or Telegram account. This authentication is required only the first time you run the script.

4. **Select Chat/Channel/Group**: After logging in, choose the target chat, channel, or group you want to scrape. Use the arrow keys to move and select the target chat.

5. **Wait for Download**: The script will start downloading all available media files and messages from the specified channel, group, or user. Depending on the size of the content, this process may take some time.

6. **Access Downloaded Files**: Once the download is complete, you can find the downloaded media files in your system's Downloads folder (or home directory if Downloads is unavailable). Each channel creates its own folder named `ChannelName_ChannelId`.

## CLI

Run the application using `npm start`:

```bash
npm start
```

This launches `download-channel` in interactive mode, prompting you to select a channel and download options.

### Advanced CLI Usage

For additional commands or to pass options directly, use `node cli.js`:

```bash
node cli.js [script-name] --options
```

**Available Commands:**

| Script Name               | Description                                                   |
|---------------------------|---------------------------------------------------------------|
| `download-channel`         | Download all media from a channel (default)                   |
| `listen-channel`           | Listen to a channel and download media from incoming messages |
| `download-selected-message`| Download media from selected messages                         |
| `download-from-links`      | Download videos from messages linked within a source message  |

**Example:**

```bash
node cli.js listen-channel --channelId=12345
```

### Date Filtering

The `download-channel` command supports filtering messages by date using the `--from_date` and `--until_date` options. Dates must be in `DD/MM/YYYY` format.

| Option        | Description                                      |
|---------------|--------------------------------------------------|
| `--from_date` | Only download messages posted on or after this date |
| `--until_date`| Only download messages posted on or before this date |

**Examples:**

```bash
# Download only messages from December 25, 2024 onwards
node cli.js download-channel --channelId=12345 --from_date=25/12/2024

# Download only messages up to December 31, 2024
node cli.js download-channel --channelId=12345 --until_date=31/12/2024

# Download messages within a specific date range
node cli.js download-channel --channelId=12345 --from_date=01/12/2024 --until_date=31/12/2024
```

### Download from Links

The `download-from-links` command downloads videos from messages that are linked within a source message. This is useful when a Telegram message contains a list of links to other messages (e.g., an index or playlist), and you want to download all the videos referenced in those links.

**Usage:**

```bash
node cli.js download-from-links --url="https://t.me/c/2623426951/3/17039"
```

Or run without arguments to be prompted for the URL:

```bash
node cli.js download-from-links
```

**Supported URL formats:**

| Format | Description |
|--------|-------------|
| `https://t.me/c/CHANNEL_ID/THREAD_ID/MESSAGE_ID` | Private channel with thread/topic |
| `https://t.me/c/CHANNEL_ID/MESSAGE_ID` | Private channel |
| `https://t.me/USERNAME/MESSAGE_ID` | Public channel by username |

**How it works:**

1. Fetches the source message from the provided URL
2. Extracts all Telegram message links from its content
3. For each link, checks the linked message and up to 5 messages after it for videos (handles "announcement + video" patterns)
4. Downloads all found videos to `~/Downloads/linked_<ChannelName>_<MessageId>/video/`

**Features:**

* Resumable downloads - interrupted downloads continue from where they left off
* Skips already downloaded files on subsequent runs
* Handles gaps in message IDs (deleted messages, text replies between announcement and video)
* Deduplicates videos that may be referenced by multiple links

## Additional Notes

* **Session Handling**: The `sessionId` field in the `config.json` file will be automatically updated after logging in for the first time. This session ID is used for subsequent logins to avoid re-entering your credentials.
* **Media Types**: The Telegram Channel Downloader supports downloading photos and documents (videos, audio files, stickers, and other file attachments).

## Contributing

Contributions are welcome! If you have any suggestions, bug reports, or feature requests, please open an issue or submit a pull request.

Happy coding
