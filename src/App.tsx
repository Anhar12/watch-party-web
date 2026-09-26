import {
  useEffect,
  useRef,
  useState,
} from "react";

import { io, Socket } from "socket.io-client";

import "./App.css";

declare global {
  interface HTMLVideoElement {
    captureStream(): MediaStream;
  }
}

type Role = "host" | "viewer";

type ConnectionStatus =
  | "connecting"
  | "waiting"
  | "connecting-peer"
  | "connected"
  | "disconnected"
  | "host-left";

type PlaybackState = {
  type: "playback-state";
  position: number;
  playing: boolean;
  duration: number;
};

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  return `${minutes}:${String(
    remainingSeconds,
  ).padStart(2, "0")}`;
}

function App() {
  const socketRef = useRef<Socket | null>(null);

  const localVideoRef =
    useRef<HTMLVideoElement | null>(null);

  const remoteVideoRef =
    useRef<HTMLVideoElement | null>(null);

  const remoteStreamRef =
    useRef<MediaStream | null>(null);

  const peerConnectionRef =
    useRef<RTCPeerConnection | null>(null);

  const dataChannelRef =
    useRef<RTCDataChannel | null>(null);

  const localStreamRef =
    useRef<MediaStream | null>(null);

  const localAudioTrackRef =
    useRef<MediaStreamTrack | null>(null);

  const viewerIdRef =
    useRef<string | null>(null);

  const videoUrlRef =
    useRef<string | null>(null);

  const playbackIntervalRef =
    useRef<number | null>(null);
  
  const mediaUpdateIdRef =
    useRef(0);

  const [connected, setConnected] =
    useState(false);

  const [role, setRole] =
    useState<Role | null>(null);

  const [roomId, setRoomId] =
    useState("");

  const [roomInput, setRoomInput] =
    useState("");

  const [status, setStatus] =
    useState("Connecting...");

  const [videoName, setVideoName] =
    useState("");

  const [remotePosition, setRemotePosition] =
    useState(0);

  const [remoteDuration, setRemoteDuration] =
    useState(0);

  const [remotePlaying, setRemotePlaying] =
    useState(false);

  const [remotePlaybackBlocked, setRemotePlaybackBlocked] =
    useState(false);

	const [remoteUpdatedAt, setRemoteUpdatedAt] =
  	useState(0);

  const [volume, setVolume] =
    useState(1);

  const [message, setMessage] =
    useState("");

  const [messages, setMessages] =
    useState<string[]>([]);

  const [logs, setLogs] =
    useState<string[]>([]);
	
	const [displayPosition, setDisplayPosition] =
  	useState(0);

	const [, setConnectionStatus] =
 		useState<ConnectionStatus>("connecting");

  function log(text: string) {
    console.log(text);

    setLogs((previous) => [
      ...previous,
      text,
    ]);
  }

  useEffect(() => {
    const SERVER_URL =
			import.meta.env.VITE_SERVER_URL;

		const socket = io(SERVER_URL);

    socketRef.current = socket;

    socket.on("connect", () => {
			setConnected(true);

			setConnectionStatus("connecting");

			log(`Connected: ${socket.id}`);
		});

    socket.on("disconnect", () => {
      setConnected(false);
      setConnectionStatus("disconnected");
      setStatus("Disconnected");

      log("Disconnected");
    });

    socket.on("room-created", (data) => {
			setRole("host");
			setRoomId(data.roomId);

			setConnectionStatus("waiting");

			setStatus(
				"Waiting for viewer...",
			);

			log(
				`Room created: ${data.roomId}`,
			);
		});

    socket.on("room-joined", (data) => {
			setRole("viewer");
			setRoomId(data.roomId);

			setConnectionStatus(
				"connecting-peer",
			);

			setStatus(
				"Connecting to host...",
			);

			log(
				`Joined room: ${data.roomId}`,
			);
		});

    socket.on(
      "room-error",
      (data) => {
        log(
          `ERROR: ${data.message}`,
        );

        setStatus(
          data.message,
        );
      },
    );

    socket.on(
      "viewer-joined",
      async (data) => {
        viewerIdRef.current =
          data.viewerId;

        log(
          `Viewer joined: ${data.viewerId}`,
        );

        /*
         * Jangan langsung createOffer()
         * kalau Host belum memilih video.
         *
         * Kalau video sudah tersedia,
         * langsung mulai WebRTC.
         */
        if (
          localVideoRef.current?.src
        ) {
          await startWebRTC(
            data.viewerId,
          );
        } else {
          log(
            "Viewer joined. Waiting for host video.",
          );
        }
      },
    );

    socket.on(
      "webrtc-offer",
      async (data) => {
        log(
          `Received offer from ${data.sender}`,
        );

        await handleOffer(
          data.sender,
          data.offer,
        );
      },
    );

    socket.on(
      "webrtc-answer",
      async (data) => {
        const peer =
          peerConnectionRef.current;

        if (!peer) {
          return;
        }

        await peer.setRemoteDescription(
          data.answer,
        );

        log(
          "Remote answer applied",
        );
      },
    );

    socket.on(
      "webrtc-ice-candidate",
      async (data) => {
        const peer =
          peerConnectionRef.current;

        if (!peer) {
          return;
        }

        try {
          await peer.addIceCandidate(
            data.candidate,
          );
        } catch (error) {
          console.error(
            "ICE error:",
            error,
          );
        }
      },
    );

    socket.on(
      "viewer-left",
      (data) => {
        log(
          `Viewer left: ${data.viewerId}`,
        );

        if (
          viewerIdRef.current ===
          data.viewerId
        ) {
          viewerIdRef.current = null;
          cleanupPeerConnection();
          setConnectionStatus("waiting");
          setStatus("Waiting for viewer...");
        }
      },
    );

    socket.on(
      "host-left",
      () => {
        cleanupPeerConnection();
        setConnectionStatus("host-left");
        setStatus("Host left the room");
        setRole(null);
        setRoomId("");

        log("Host left room");
      },
    );

    return () => {
      cleanupPeerConnection();
      socket.disconnect();

      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
    };
  }, []);

	useEffect(() => {
    if (role !== "host") {
      return;
    }

    const video = localVideoRef.current;

    if (!video) {
      return;
    }

    const handlePlaybackChange = () => {
      sendPlaybackState();

      if (!video.paused) {
        const peer = peerConnectionRef.current;
        const viewerId = viewerIdRef.current;

        if (peer && viewerId) {
          void syncAudioTrack(peer, video, viewerId);
        }
      }
    };

    const handleEnded = () => {
      log("Host video ended.");
      sendPlaybackState();
    };

    video.addEventListener(
      "play",
      handlePlaybackChange,
    );

    video.addEventListener(
      "pause",
      handlePlaybackChange,
    );

    video.addEventListener(
      "seeked",
      handlePlaybackChange,
    );

    video.addEventListener(
      "loadedmetadata",
      handlePlaybackChange,
    );

    video.addEventListener(
      "ended",
      handleEnded,
    );

    return () => {
      video.removeEventListener(
        "play",
        handlePlaybackChange,
      );

      video.removeEventListener(
        "pause",
        handlePlaybackChange,
      );

      video.removeEventListener(
        "seeked",
        handlePlaybackChange,
      );

      video.removeEventListener(
        "loadedmetadata",
        handlePlaybackChange,
      );

      video.removeEventListener(
        "ended",
        handleEnded,
      );
    };
  }, [role]);

	useEffect(() => {
		if (
			role !== "viewer" ||
			!remotePlaying
		) {
			setDisplayPosition(
				remotePosition,
			);

			return;
		}

		const interval =
			window.setInterval(() => {
				const elapsed =
					(performance.now() -
						remoteUpdatedAt) /
					1000;

				const position =
					remotePosition +
					elapsed;

				setDisplayPosition(
					Math.min(
						position,
						remoteDuration || position,
					),
				);
			}, 100);

		return () => {
			window.clearInterval(
				interval,
			);
		};
	}, [
		role,
		remotePlaying,
		remotePosition,
		remoteDuration,
		remoteUpdatedAt,
	]);

  function createPeerConnection(
    remoteId: string,
  ) {
    const peer =
      new RTCPeerConnection({
        iceServers: [
          {
            urls:
              "stun:stun.l.google.com:19302",
          },
        ],
      });

    peerConnectionRef.current =
      peer;

    peer.onicecandidate =
      (event) => {
        if (!event.candidate) {
          return;
        }

        socketRef.current?.emit(
          "webrtc-ice-candidate",
          {
            target: remoteId,
            candidate:
              event.candidate,
          },
        );
      };

    peer.onconnectionstatechange = () => {
			const state =
				peer.connectionState;

			log(`WebRTC: ${state}`);

			if (state === "connected") {
				setConnectionStatus("connected");

				setStatus(
					role === "host"
						? "Viewer connected"
						: "Connected to host",
				);
			}

			if (
				state === "failed" ||
				state === "disconnected"
			) {
				setConnectionStatus(
					"disconnected",
				);

				setStatus(
					"Connection lost",
				);
			}
		};

    peer.ontrack = (event) => {
      const stream =
        remoteStreamRef.current ?? new MediaStream();

      for (const incomingStream of event.streams) {
        for (const track of incomingStream.getTracks()) {
          if (!stream.getTracks().includes(track)) {
            stream.addTrack(track);
          }
        }
      }

      if (!stream.getTracks().includes(event.track)) {
        stream.addTrack(event.track);
      }

      remoteStreamRef.current = stream;

      if (
        remoteVideoRef.current
      ) {
        const remoteVideo = remoteVideoRef.current;
        remoteVideo.srcObject = stream;

        void remoteVideo.play()
          .then(() => {
            setRemotePlaybackBlocked(false);
          })
          .catch((error: unknown) => {
            setRemotePlaybackBlocked(true);
            log(
              `Playback needs user interaction: ${String(error)}`,
            );
          });
      }

      log(
        "Remote video stream received",
      );
    };

    peer.ondatachannel =
      (event) => {
        setupDataChannel(
          event.channel,
        );
      };

    return peer;
  }

  function setupDataChannel(
    channel: RTCDataChannel,
  ) {
    dataChannelRef.current =
      channel;

    channel.onopen = () => {
      log("DataChannel OPEN");

      if (role === "host") {
        startPlaybackSync();
      }
    };

    channel.onclose = () => {
      log("DataChannel CLOSED");
    };

    channel.onmessage = (event) => {
      try {
        const data =
          JSON.parse(event.data);

        if (
          data.type ===
          "playback-state"
        ) {
          setRemotePosition(
            data.position ?? 0,
          );

          setRemoteDuration(
            data.duration ?? 0,
          );

          setRemotePlaying(
            data.playing ?? false,
          );

					setRemoteUpdatedAt(
						performance.now(),
					);

          return;
        }

        setMessages(
          (previous) => [
            ...previous,
            `Remote: ${event.data}`,
          ],
        );
      } catch {
        setMessages(
          (previous) => [
            ...previous,
            `Remote: ${event.data}`,
          ],
        );
      }
    };
  }

	function sendPlaybackState() {
		const channel = dataChannelRef.current;
		const video = localVideoRef.current;

		if (
			role !== "host" ||
			!channel ||
			channel.readyState !== "open" ||
			!video ||
			!video.src
		) {
			return;
		}

		const state: PlaybackState = {
			type: "playback-state",
			position: video.currentTime,
			playing: !video.paused,
			duration: Number.isFinite(video.duration)
				? video.duration
				: 0,
		};

		channel.send(JSON.stringify(state));
	}


  function startPlaybackSync() {
		if (playbackIntervalRef.current) {
			window.clearInterval(
				playbackIntervalRef.current,
			);
		}

		/*
		* Kirim state langsung saat mulai.
		*/
		sendPlaybackState();

		/*
		* Heartbeat untuk menjaga posisi tetap
		* sinkron walaupun tidak ada event playback.
		*/
		playbackIntervalRef.current =
			window.setInterval(() => {
				sendPlaybackState();
			}, 500);
	}

  async function attachVideoToPeer(
    peer: RTCPeerConnection,
    video: HTMLVideoElement,
  ): Promise<boolean> {
    // Capture the currently selected source. Tracks from the previous
    // source can remain in the peer connection after video.src changes.
    const stream = video.captureStream();
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0] ?? null;

    if (!videoTrack) {
      stream.getTracks().forEach((track) => track.stop());
      log("No video track available from captureStream.");
      return false;
    }

    if ("contentHint" in videoTrack) {
      videoTrack.contentHint = "detail";
    }

    let needsNegotiation = false;
    const videoSender = peer
      .getTransceivers()
      .find((transceiver) => transceiver.receiver.track.kind === "video")
      ?.sender;

    if (videoSender) {
      await videoSender.replaceTrack(videoTrack);
    } else {
      peer.addTrack(videoTrack, stream);
      needsNegotiation = true;
    }

    const audioSender = peer
      .getTransceivers()
      .find((transceiver) => transceiver.receiver.track.kind === "audio")
      ?.sender;

    if (audioSender) {
      // A selected file may not expose its audio track until playback starts.
      // Keep the current sender until syncAudioTrack can attach the new one.
      if (audioTrack) {
        await audioSender.replaceTrack(audioTrack);
        if (
          localAudioTrackRef.current &&
          localAudioTrackRef.current !== audioTrack
        ) {
          localAudioTrackRef.current.stop();
        }
        localAudioTrackRef.current = audioTrack;
      }
    } else if (audioTrack) {
      peer.addTrack(audioTrack, stream);
      if (
        localAudioTrackRef.current &&
        localAudioTrackRef.current !== audioTrack
      ) {
        localAudioTrackRef.current.stop();
      }
      localAudioTrackRef.current = audioTrack;
      needsNegotiation = true;
    }

    const previousStream = localStreamRef.current;
    localStreamRef.current = stream;
    const activeTracks = new Set(
      peer.getSenders().flatMap((sender) =>
        sender.track ? [sender.track] : [],
      ),
    );

    previousStream?.getTracks().forEach((track) => {
      if (
        track !== videoTrack &&
        track !== audioTrack &&
        !activeTracks.has(track)
      ) {
        track.stop();
      }
    });

    log(
      `Capture stream attached: video=${!!videoTrack}, audio=${!!audioTrack}, renegotiation=${needsNegotiation}`,
    );

    return needsNegotiation;
  }

  async function syncAudioTrack(
    peer: RTCPeerConnection,
    video: HTMLVideoElement,
    viewerId: string,
  ) {
    const stream = video.captureStream();
    const audioTrack = stream.getAudioTracks()[0];

    stream.getVideoTracks().forEach((track) => track.stop());

    if (!audioTrack) {
      return;
    }

    const audioSender = peer
      .getTransceivers()
      .find((transceiver) => transceiver.receiver.track.kind === "audio")
      ?.sender;

    if (audioSender) {
      await audioSender.replaceTrack(audioTrack);
    } else {
      peer.addTrack(
        audioTrack,
        localStreamRef.current ?? stream,
      );

      if (peer.signalingState === "stable") {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);

        socketRef.current?.emit("webrtc-offer", {
          target: viewerId,
          offer: peer.localDescription,
        });

        log("WebRTC renegotiation offer sent for audio track");
      }
    }

    if (
      localAudioTrackRef.current &&
      localAudioTrackRef.current !== audioTrack
    ) {
      localAudioTrackRef.current.stop();
    }

    localAudioTrackRef.current = audioTrack;
  }

  async function startWebRTC(
    viewerId: string,
    expectedUpdateId?: number,
  ) {
    const video = localVideoRef.current;

    if (!video?.src) {
      log("No host video selected.");
      return;
    }

    await waitForVideoReady(video);

    if (
      expectedUpdateId !== undefined &&
      expectedUpdateId !== mediaUpdateIdRef.current
    ) {
      return;
    }

    let peer = peerConnectionRef.current;

    if (!peer) {
      peer = createPeerConnection(viewerId);

      const channel = peer.createDataChannel("watch-party");
      setupDataChannel(channel);
    }

    const needsNegotiation =
      await attachVideoToPeer(peer, video);

    await configureVideoSender(peer);

    if (needsNegotiation) {
      const offer = await peer.createOffer();

      await peer.setLocalDescription(offer);

      socketRef.current?.emit("webrtc-offer", {
        target: viewerId,
        offer: peer.localDescription,
      });

      log("WebRTC offer sent");
    } else {
      log("Existing capture stream reused; no renegotiation needed");
    }
  }

  async function handleOffer(
		senderId: string,
		offer: RTCSessionDescriptionInit,
	) {
		let peer =
			peerConnectionRef.current;

		if (!peer) {
			peer =
				createPeerConnection(
					senderId,
				);
		}

		await peer.setRemoteDescription(
			offer,
		);

		const answer =
			await peer.createAnswer();

		await peer.setLocalDescription(
			answer,
		);

		socketRef.current?.emit(
			"webrtc-answer",
			{
				target: senderId,
				answer:
					peer.localDescription,
			},
		);

		log(
			"WebRTC answer sent",
		);
	}

  function createRoom() {
    socketRef.current?.emit(
      "create-room",
    );
  }

	async function configureVideoSender(
		peer: RTCPeerConnection,
	) {
		const sender =
			peer
				.getSenders()
				.find(
					(sender) =>
						sender.track?.kind ===
						"video",
				);

		if (!sender) {
			return;
		}

		const parameters =
			sender.getParameters();

		if (!parameters.encodings) {
			parameters.encodings = [{}];
		}

		parameters.encodings[0] = {
			...parameters.encodings[0],

			/*
			* 8 Mbps sebagai batas awal.
			*
			* Nanti bisa kita sesuaikan
			* berdasarkan hasil testing.
			*/
			maxBitrate: 8_000_000,

			maxFramerate: 30,
		};

		await sender.setParameters(
			parameters,
		);

		log(
			"Video encoder configured",
		);
	}

  function joinRoom() {
    const id =
      roomInput
        .trim()
        .toUpperCase();

    if (!id) {
      return;
    }

    socketRef.current?.emit(
      "join-room",
      {
        roomId: id,
      },
    );
  }

  async function handleVideoChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file =
      event.target.files?.[0];

    if (!file) {
      return;
    }

    if (role !== "host") {
      return;
    }

    const video =
      localVideoRef.current;

    if (!video) {
      return;
    }

    const updateId =
      ++mediaUpdateIdRef.current;

    if (videoUrlRef.current) {
      URL.revokeObjectURL(
        videoUrlRef.current,
      );
    }

    const url =
      URL.createObjectURL(file);

    videoUrlRef.current = url;

    video.src = url;
    video.load();

    setVideoName(file.name);

    log(
      `Selected: ${file.name}`,
    );

    if (!viewerIdRef.current) {
      return;
    }

    await waitForVideoReady(video);

    /*
    * Kalau user sudah memilih video lain
    * selama kita menunggu video siap,
    * operasi ini sudah basi.
    */
    if (
      updateId !==
      mediaUpdateIdRef.current
    ) {
      return;
    }

    await startWebRTC(
      viewerIdRef.current,
      updateId,
    );
  }

	function waitForVideoReady(
		video: HTMLVideoElement,
	): Promise<void> {
		return new Promise((resolve) => {
			if (
				video.readyState >=
				HTMLMediaElement.HAVE_CURRENT_DATA
			) {
				resolve();
				return;
			}

			const handleCanPlay = () => {
				video.removeEventListener(
					"canplay",
					handleCanPlay,
				);

				resolve();
			};

			video.addEventListener(
				"canplay",
				handleCanPlay,
				{ once: true },
			);
		});
	}

  function sendMessage() {
    const channel =
      dataChannelRef.current;

    if (
      !channel ||
      channel.readyState !==
        "open"
    ) {
      return;
    }

    if (!message.trim()) {
      return;
    }

    channel.send(message);

    setMessages(
      (previous) => [
        ...previous,
        `You: ${message}`,
      ],
    );

    setMessage("");
  }

  function toggleFullscreen() {
    const video =
      remoteVideoRef.current;

    if (!video) {
      return;
    }

    if (
      document.fullscreenElement
    ) {
      document.exitFullscreen();

      return;
    }

    video.requestFullscreen?.();
  }

  function playRemoteVideo() {
    const video = remoteVideoRef.current;

    if (!video) {
      return;
    }

    void video.play()
      .then(() => {
        setRemotePlaybackBlocked(false);
      })
      .catch((error: unknown) => {
        log(`Unable to play remote video: ${String(error)}`);
      });
  }

  function handleVolumeChange(
    value: number,
  ) {
    setVolume(value);

    if (
      remoteVideoRef.current
    ) {
      remoteVideoRef.current.volume =
        value;
    }
  }

	function cleanupPeerConnection() {
		if (
			playbackIntervalRef.current
		) {
			window.clearInterval(
				playbackIntervalRef.current,
			);

			playbackIntervalRef.current =
				null;
		}

		dataChannelRef.current?.close();

		dataChannelRef.current = null;

		peerConnectionRef.current?.close();

		peerConnectionRef.current = null;

		localStreamRef.current
			?.getTracks()
			.forEach((track) => {
				track.stop();
			});

		localStreamRef.current = null;

		localAudioTrackRef.current?.stop();
		localAudioTrackRef.current = null;

		if (
			remoteVideoRef.current
		) {
			remoteVideoRef.current.srcObject =
				null;
		}

		remoteStreamRef.current = null;
	}

	function leaveRoom() {
		cleanupPeerConnection();
		viewerIdRef.current = null;

		socketRef.current?.emit(
			"leave-room",
		);

		setRole(null);
		setRoomId("");
		setRoomInput("");
		setVideoName("");

		if (videoUrlRef.current) {
			URL.revokeObjectURL(videoUrlRef.current);
			videoUrlRef.current = null;
		}

		setRemotePosition(0);
		setRemoteDuration(0);
		setRemotePlaying(false);

		setConnectionStatus(
			"connecting",
		);

		setStatus("Connected");
	}

  /*
   * LANDING
   */
  if (!role) {
    return (
      <div className="min-h-screen bg-slate-950 text-white">
        <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6">
          <div className="grid w-full gap-10 md:grid-cols-2">
            <div>
              <div className="mb-5 inline-flex rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300">
                Watch Party
              </div>

              <h1 className="text-5xl font-bold tracking-tight">
                Watch together,
                <br />
                wherever you are.
              </h1>

              <p className="mt-5 max-w-lg text-lg leading-relaxed text-slate-400">
                Bagikan film yang ada di
                perangkatmu dan tonton
                bersama teman secara
                langsung. File video tetap
                berada di perangkat Host.
              </p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-7 shadow-2xl">
              <h2 className="text-2xl font-semibold">
                Start watching
              </h2>

              <p className="mt-2 text-sm text-slate-400">
                Buat room baru atau masuk
                menggunakan kode room.
              </p>

              <button
                onClick={createRoom}
                disabled={!connected}
                className="mt-6 w-full rounded-xl bg-white px-5 py-3 font-semibold text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create Room
              </button>

              <div className="my-5 flex items-center gap-3 text-xs text-slate-500">
                <div className="h-px flex-1 bg-white/10" />
                OR
                <div className="h-px flex-1 bg-white/10" />
              </div>

              <input
                value={roomInput}
                onChange={(event) =>
                  setRoomInput(
                    event.target.value,
                  )
                }
                placeholder="Enter room code"
                className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none placeholder:text-slate-600 focus:border-white/30"
              />

              <button
                onClick={joinRoom}
                disabled={
                  !connected ||
                  !roomInput.trim()
                }
                className="mt-3 w-full rounded-xl border border-white/10 bg-white/10 px-5 py-3 font-semibold transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Join Room
              </button>

              <div className="mt-5 text-center text-xs text-slate-500">
                {connected
                  ? "Connected to server"
                  : "Connecting..."}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /*
   * ROOM
   */
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-white/10 bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <div className="font-bold">
              Watch Party
            </div>

            <div className="text-xs text-slate-500">
              {status}
            </div>
          </div>

          <div className="rounded-lg bg-white/5 px-4 py-2 font-mono text-sm">
            {roomId}
          </div>

					<button
						onClick={leaveRoom}
						className="rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-400/20"
					>
						Leave Room
					</button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {role === "host" && (
          <section className="mb-8 rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="font-semibold">
                  Host controls
                </h2>

                <p className="mt-1 text-sm text-slate-400">
                  Pilih film dari perangkatmu.
                  Film tidak di-upload ke server.
                </p>
              </div>

              <label className="cursor-pointer rounded-xl bg-white px-5 py-3 text-center font-semibold text-slate-950 hover:bg-slate-200">
                Choose Video
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/*"
                  onChange={
                    handleVideoChange
                  }
                  className="hidden"
                />
              </label>
            </div>

            {videoName && (
              <div className="mt-4 rounded-xl bg-black/20 px-4 py-3 text-sm text-slate-300">
                Playing:
                <span className="ml-2 font-medium text-white">
                  {videoName}
                </span>
              </div>
            )}
          </section>
        )}

        <div className="grid gap-8 lg:grid-cols-2">
          {role === "host" && (
            <section>
              <div className="mb-3">
                <h2 className="text-lg font-semibold">
                  Your screen
                </h2>

                <p className="text-sm text-slate-500">
                  Kontrol playback dari sini.
                </p>
              </div>

              <div className="overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
                <video
                  ref={localVideoRef}
                  controls
                  playsInline
                  className="aspect-video w-full bg-black"
                />
              </div>
            </section>
          )}

          <section
            className={
              role === "viewer"
                ? "lg:col-span-2"
                : ""
            }
          >
            <div className="mb-3">
              <h2 className="text-lg font-semibold">
                {role === "host"
                  ? "Viewer"
                  : "Now watching"}
              </h2>

              <p className="text-sm text-slate-500">
                {role === "host"
                  ? "Preview video yang diterima viewer."
                  : "Playback mengikuti Host."}
              </p>
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                onPlaying={() => setRemotePlaybackBlocked(false)}
                className="aspect-video w-full bg-black"
              />

              {remotePlaybackBlocked && (
                <button
                  onClick={playRemoteVideo}
                  className="absolute inset-0 flex items-center justify-center bg-black/60 px-6 text-center font-semibold text-white"
                >
                  Tap to play the stream
                </button>
              )}

              <div className="flex items-center gap-4 border-t border-white/10 bg-slate-900 px-4 py-3">
                <span className="min-w-[95px] text-sm font-mono text-slate-300">
                  {formatTime(displayPosition)} /{" "}
									{formatTime(remoteDuration)}
                </span>

                <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-white transition-all"
                    style={{
											width:
												remoteDuration > 0
													? `${
															(displayPosition /
																remoteDuration) *
															100
														}%`
													: "0%",
										}}
                  />
                </div>

                <span className="text-xs text-slate-500">
                  {remotePlaying
                    ? "Playing"
                    : "Paused"}
                </span>

                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(event) =>
                    handleVolumeChange(
                      Number(
                        event.target.value,
                      ),
                    )
                  }
                  className="w-20"
                  title="Volume"
                />

                <button
                  onClick={
                    toggleFullscreen
                  }
                  className="rounded-lg px-2 py-1 text-slate-300 hover:bg-white/10"
                  title="Fullscreen"
                >
                  ⛶
                </button>
              </div>
            </div>
          </section>
        </div>

        <section className="mt-8 grid gap-8 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <h2 className="font-semibold">
              Chat
            </h2>

            <div className="mt-4 min-h-32 rounded-xl bg-black/20 p-4 text-sm text-slate-300">
              {messages.length === 0 ? (
                <span className="text-slate-600">
                  No messages yet.
                </span>
              ) : (
                messages.map(
                  (item, index) => (
                    <div key={index}>
                      {item}
                    </div>
                  ),
                )
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <input
                value={message}
                onChange={(event) =>
                  setMessage(
                    event.target.value,
                  )
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter"
                  ) {
                    sendMessage();
                  }
                }}
                placeholder="Type a message..."
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none placeholder:text-slate-600"
              />

              <button
                onClick={sendMessage}
                className="rounded-xl bg-white px-5 font-semibold text-slate-950"
              >
                Send
              </button>
            </div>
          </div>

          <details className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <summary className="cursor-pointer font-semibold text-slate-300">
              Developer Log
            </summary>

            <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-black/30 p-4 text-xs text-slate-500">
              {logs.join("\n")}
            </pre>
          </details>
        </section>
      </main>
    </div>
  );
}

export default App;
