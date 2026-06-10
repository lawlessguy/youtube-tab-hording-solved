
## Viewing Modes & Layout

- Multiple switchable / toggleable viewing formats:
    - **In-page video queue** (built into the YouTube page HTML)
        - No extension side panel.
        - Horizontal, scrollable list of videos in the top bar, beside the YouTube search field.
    - **Slim side panel**
        - Shows thumbnails only; panel width equals a single thumbnail.
## Video Player
- Resizable video player: drag the edges of the YouTube video to change its bounding box on youtube.com. Works in every mode except full screen.
- Timeline history (Ctrl-Z / Shift-Z): step backward and forward through previous timeline positions after seeking.
- **Picture in Picture** Auto-enable PiP when the currently playing video's tab is not open / visible on screen.
    - Transparency slider for the floating PiP player.
    - Preset toggles / buttons to quickly set PiP position and size.
* Make it so the playback speed slider in the native YouTube videos setting panel syncs in real time with the video speed slider in the extensions dropdown window and the extensions right side panel in chrome.

## Video List & Side Panel

- Create multiple separate sessions, and optionally merge a session's videos into the main session's video list.
- Filter by channel: click a channel name on a video in the side panel to show only that channel's videos.
- Smart play: if a listed video is already open in a tab, double-clicking it navigates to that existing tab instead of replaying it in the current tab.
- **Middle-Click Navigation** — Middle-clicking a video in the list opens it in a new tab.
    - **Auto-Intercept Bypass** — If "Auto-Intercept" is on, it will ignore tabs opened via middle-click from the side panel list so they stay open for the user instead of automatically closing.
## Status Indicators & Badges

- **Already in list** — On native YouTube recommended thumbnails, show an indicator (top-left) if that video has been added and is visibly in the video list or the shorts list in the extension's side panel.
- **Open as tab** — On side-panel thumbnails, show an indicator (top-left) if the video is currently open as a Chrome tab.
- **Add / move count** — Tag each video with how many times it has been added or moved to the top of the list.
- **Thumbnail Overlays** — Display the video length (e.g., "10:47") in the bottom-right corner of every thumbnail in the side panel, mirroring native youtube.com functionality.
## Analytics

- Track viewing trends — what you watch and how long you watch each video — then build correlations to power a **"Suggested videos"** sort option.
- Build a log database of my YouTube activity with as many useful datapoints as possible to possibly be used later by other AI's
- **Silent Background Capture** — Even if "Auto-Intercept" is OFF, the extension continuously logs every YouTube video opened in any current window or new tab into a background data sheet.
## YouTube Shorts

- Left / right arrow-key scrubbing.
- Watch Shorts directly inside the extension side panel.
- Context-aware panel: when on a Shorts tab, swap the right-side panel buttons/info for Shorts-specific tools.
	- Build extensions UI elements directly into page, their is plenty of empty space on either side of YouTube short videos
- Auto-behavior toggles:
    - Auto-scroll to the next Short when the video finishes.
    - Close the Shorts tab when the video finishes.
