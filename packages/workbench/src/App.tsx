
  useEffect(() => {
    return () => {
      runtimeStreamRef.current?.getTracks().forEach((track) => track.stop());
      runtimeStreamRef.current = undefined;
      void window.runtimeDesktop?.stopSimulatorFramebuffer();
      if (viewportBenchmarkTimerRef.current) {
        clearTimeout(viewportBenchmarkTimerRef.current);
      }
      viewportBenchmarkRef.current.active = false;
      framebufferCanvasRef.current
        ?.getContext("2d")
        ?.clearRect(
          0,
          0,
          framebufferCanvasRef.current.width,
          framebufferCanvasRef.current.height
        );
    };
  }, []);
  const isRecording = Boolean(recording && !recording.complete);

  const samples = useMemo(() => {
    if (!recording || !probeId) return [];
    return recording.samples
      .map((sample) => {
        const value = sample.values[probeId];
        return typeof value === "number" ? { t: sample.t, value } : undefined;
      })
      .filter((sample): sample is { t: number; value: number } => Boolean(sample));
  }, [recording, probeId]);

  function toggleRecording() {
    if (isRecording) {
      session.stopRecording();
      return;
    }
    if (!schemaId || !probeId) return;
    session.startRecording(schemaId, [probeId], 60);
  }

  function replay() {
    if (!schemaId) return;
    const schema = state.schemas.find((item) => item.id === schemaId);
    const replayControl = schema?.groups
      .flatMap((group) => group.controls)
      .find(
        (control) =>
          control.kind === "trigger" &&
          (control.id.toLowerCase().includes("replay") ||
            control.binding?.toLowerCase().includes("replay"))
      );
    if (replayControl) {
      session.fireTrigger(schemaId, replayControl.id);
    }
  }

  function runViewportBenchmark() {
    if (
      !schemaId ||
      runtimeCapture?.source !== "framebuffer" ||
      viewportBenchmarkBusy
    ) {
      return;
    }

    if (state.status !== "connected") {
      setRuntimeCaptureError(
        "Runtime disconnected. Start the Runtime Inspector broker, reconnect the app, then run the viewport benchmark."
      );
      return;
    }

    const schema = state.schemas.find((item) => item.id === schemaId);
    const benchmarkControl = schema?.groups
      .flatMap((group) => group.controls)
      .find(
        (control) =>
          control.kind === "trigger" &&
          (control.id.toLowerCase().includes("benchmarkviewport") ||
            control.id.toLowerCase().includes("benchmark") ||
            control.binding?.toLowerCase().includes("benchmark"))
      );

    if (!benchmarkControl) {
      setRuntimeCaptureError(
        "This runtime does not expose the deterministic viewport benchmark trigger."
      );
      return;
    }

    setRuntimeCaptureError(undefined);
    setViewportBenchmarkResult(undefined);
    setViewportBenchmarkBusy(true);
    viewportBenchmarkRef.current = {
      active: true,
      frameTimes: [],
      encodeMs: [],
      decodeMs: [],
      latencyMs: []
    };

    session.fireTrigger(schemaId, benchmarkControl.id);

    viewportBenchmarkTimerRef.current = setTimeout(() => {
      const samples = viewportBenchmarkRef.current;
      samples.active = false;
      viewportBenchmarkTimerRef.current = undefined;

      const times = samples.frameTimes;
      const durationMs =
        times.length > 1 ? times[times.length - 1] - times[0] : 0;
      const frameIntervals = times
        .slice(1)
        .map((time, index) => time - times[index])
        .filter((value) => value > 0);

      setViewportBenchmarkBusy(false);

      if (
        times.length < 2 ||
        durationMs <= 0 ||
        samples.encodeMs.length === 0
      ) {
        setRuntimeCaptureError(
          "Viewport benchmark did not receive enough live framebuffer samples."
        );
        return;
      }

      setViewportBenchmarkResult({
        frames: times.length,
        durationMs,
        frameRate: ((times.length - 1) * 1000) / durationMs,
        frameIntervalP95Ms: percentile(frameIntervals, 0.95),
        encodeP95Ms: percentile(samples.encodeMs, 0.95),
        decodeP95Ms: percentile(samples.decodeMs, 0.95),
        latencyP95Ms: percentile(samples.latencyMs, 0.95)
      });
    }, 3600);
  }

  async function attachRuntimeCapture() {
    const desktop = window.runtimeDesktop;
    setRuntimeCaptureError(undefined);
    setDesktopBusy(Boolean(desktop));

    try {
      runtimeStreamRef.current?.getTracks().forEach((track) => track.stop());

      if (desktop) {
        setFramebufferFrameSource(undefined);
        const prepared = await desktop.startSimulatorFramebuffer(selectedSimulatorUdid);
        setSelectedSimulatorUdid(prepared.device.udid);
        setSimulators(await desktop.listSimulators());
        setInputReady(prepared.input.ready);
        framebufferBootstrapRef.current = prepared.bootstrapFrame;
        framebufferTimesRef.current = [];
        framebufferLatencyRef.current = [];
        framebufferEncodeRef.current = [];
        framebufferDecodeRef.current = [];
        framebufferStatsUpdateRef.current = 0;
        setViewportBenchmarkResult(undefined);
        viewportBenchmarkRef.current = {
          active: false,
          frameTimes: [],
          encodeMs: [],
          decodeMs: [],
          latencyMs: []
        };
        setFramebufferHasFrame(false);
        setRuntimeCapture({
          label: `${prepared.device.name} · ${prepared.device.runtime}`,
          source: "framebuffer"
        });
        if (!prepared.input.ready) {
          setRuntimeCaptureError(prepared.input.error ?? "Simulator HID input is unavailable.");
        }
        return;
      }

      if (!navigator.mediaDevices?.getDisplayMedia) {
        setRuntimeCaptureError("This browser does not support window capture.");
        return;
      }

      setInputReady(false);

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 }
        },
        audio: false
      });

      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        setRuntimeCaptureError("The selected source did not provide a video track.");
        return;
      }

      const settings = track.getSettings() as MediaTrackSettings & {
        displaySurface?: string;
      };

      runtimeStreamRef.current = stream;
      setRuntimeCapture({
        label: track.label || "Captured window",
        source: "window",
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        displaySurface: settings.displaySurface
      });

      track.onended = () => {
        runtimeStreamRef.current = undefined;
        if (runtimeVideoRef.current) {
          runtimeVideoRef.current.srcObject = null;
        }
        setRuntimeCapture(undefined);
        setInputReady(false);
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setRuntimeCaptureError("Window capture was cancelled or Screen Recording permission was denied.");
        return;
      }
      setRuntimeCaptureError(
        error instanceof Error ? error.message : "Could not attach the runtime surface."