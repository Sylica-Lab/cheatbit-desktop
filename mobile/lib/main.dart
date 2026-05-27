import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';

import 'native_bridge.dart';
import 'relay_client.dart';
import 'relay_models.dart';
import 'relay_storage.dart';

void main() {
  runApp(const SylicaMobileApp());
}

Uri _desktopScreenFrameUriFor(
  RelayCredentials credentials,
  int tick, {
  int width = 1280,
}) {
  final baseUrl = credentials.apiBaseUrl.trim().replaceFirst(
    RegExp(r'/$'),
    '',
  );
  return Uri.parse('$baseUrl/api/desktop/screen.jpg').replace(
    queryParameters: {
      'pairingId': credentials.pairingId,
      'deviceToken': credentials.deviceToken,
      'width': '$width',
      't': '$tick',
    },
  );
}

// ─── Design tokens ────────────────────────────────────────────────
//
// One palette, used consistently. Accent (`brand`) is reserved for
// active / live / pressed states only; never decorative.
class _Palette {
  static const bg = Color(0xFF0A0E0C);
  static const surface = Color(0xFF141A17);
  static const surfaceHi = Color(0xFF1A211D);
  static const hairline = Color(0x14FFFFFF);
  static const hairlineSoft = Color(0x09FFFFFF);

  static const text = Color(0xFFEDEFEC);
  static const textMuted = Color(0xFF8B928C);
  static const textFaint = Color(0xFF565C57);

  static const brand = Color(0xFF7DF9C7);
  static const brandSoft = Color(0xFF3E8870);
  static const warn = Color(0xFFE7C284);
  static const danger = Color(0xFFE49191);
}

ThemeData _buildSylicaTheme() {
  const baseFont = 'Roboto';
  const text = _Palette.text;
  const muted = _Palette.textMuted;

  return ThemeData(
    brightness: Brightness.dark,
    fontFamily: baseFont,
    scaffoldBackgroundColor: _Palette.bg,
    canvasColor: _Palette.bg,
    splashFactory: InkSparkle.splashFactory,
    useMaterial3: true,
    colorScheme: const ColorScheme.dark(
      primary: _Palette.brand,
      onPrimary: Color(0xFF062018),
      secondary: _Palette.brand,
      onSecondary: Color(0xFF062018),
      surface: _Palette.surface,
      onSurface: text,
      error: _Palette.danger,
      onError: Color(0xFF1A0808),
      outline: _Palette.hairline,
    ),
    textTheme: const TextTheme(
      displaySmall: TextStyle(
        color: text,
        fontSize: 28,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.6,
        height: 1.1,
      ),
      headlineSmall: TextStyle(
        color: text,
        fontSize: 22,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.4,
        height: 1.2,
      ),
      titleLarge: TextStyle(
        color: text,
        fontSize: 17,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.2,
      ),
      titleMedium: TextStyle(
        color: text,
        fontSize: 15,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.1,
      ),
      bodyLarge: TextStyle(
        color: text,
        fontSize: 15,
        fontWeight: FontWeight.w400,
        height: 1.45,
      ),
      bodyMedium: TextStyle(
        color: muted,
        fontSize: 14,
        fontWeight: FontWeight.w400,
        height: 1.45,
      ),
      bodySmall: TextStyle(
        color: muted,
        fontSize: 12.5,
        fontWeight: FontWeight.w400,
        height: 1.4,
      ),
      labelLarge: TextStyle(
        color: text,
        fontSize: 13,
        fontWeight: FontWeight.w500,
        letterSpacing: 0,
      ),
      labelSmall: TextStyle(
        color: muted,
        fontSize: 11,
        fontWeight: FontWeight.w500,
        letterSpacing: 0.4,
      ),
    ),
    iconTheme: const IconThemeData(color: muted, size: 20),
    dividerColor: _Palette.hairlineSoft,
    appBarTheme: const AppBarTheme(
      backgroundColor: _Palette.bg,
      elevation: 0,
      scrolledUnderElevation: 0,
      iconTheme: IconThemeData(color: text),
      titleTextStyle: TextStyle(
        color: text,
        fontSize: 16,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.2,
      ),
    ),
    cardColor: _Palette.surface,
    cardTheme: const CardThemeData(
      color: _Palette.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(16)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: _Palette.surface,
      hintStyle: const TextStyle(color: _Palette.textFaint, fontSize: 14),
      labelStyle: const TextStyle(color: muted, fontSize: 13),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: _Palette.hairlineSoft),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: _Palette.hairlineSoft),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: _Palette.brandSoft, width: 1.2),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: _Palette.text,
        foregroundColor: const Color(0xFF0A0E0C),
        textStyle: const TextStyle(
          fontWeight: FontWeight.w600,
          letterSpacing: -0.1,
          fontSize: 14.5,
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: _Palette.text,
        textStyle: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14),
        side: const BorderSide(color: _Palette.hairline),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(
        foregroundColor: muted,
        highlightColor: _Palette.surfaceHi,
      ),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: _Palette.brand,
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.selected)) {
          return const Color(0xFF062018);
        }
        return _Palette.textMuted;
      }),
      trackColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.selected)) {
          return _Palette.brand;
        }
        return _Palette.surfaceHi;
      }),
      trackOutlineColor: const WidgetStatePropertyAll(_Palette.hairlineSoft),
    ),
    listTileTheme: const ListTileThemeData(
      iconColor: muted,
      textColor: text,
      titleTextStyle: TextStyle(
        color: text,
        fontWeight: FontWeight.w500,
        fontSize: 14.5,
      ),
      subtitleTextStyle: TextStyle(color: muted, fontSize: 13, height: 1.4),
    ),
  );
}

class SylicaMobileApp extends StatelessWidget {
  const SylicaMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Sylica',
      debugShowCheckedModeBanner: false,
      theme: _buildSylicaTheme(),
      home: const SylicaGatewayShell(),
    );
  }
}

class SylicaGatewayShell extends StatefulWidget {
  const SylicaGatewayShell({super.key});

  @override
  State<SylicaGatewayShell> createState() => _SylicaGatewayShellState();
}

class _SylicaGatewayShellState extends State<SylicaGatewayShell>
    with WidgetsBindingObserver {
  final _storage = const RelayStorage();
  final _nativeBridge = NativeBridge();
  RelayCredentials? _credentials;
  bool _isLoading = true;
  bool _notificationAccess = false;
  String _deviceName = 'Sylica Mobile';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _bootstrap();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _refreshNotificationAccess();
    }
  }

  Future<void> _bootstrap() async {
    final deviceName = await _nativeBridge.getDeviceName();
    final credentials = await _storage.load();
    if (credentials != null) {
      await _nativeBridge.saveRelayCredentials(credentials);
    }
    final notificationAccess = await _nativeBridge
        .isNotificationListenerEnabled();
    if (!mounted) return;
    setState(() {
      _deviceName = deviceName;
      _credentials = credentials;
      _notificationAccess = notificationAccess;
      _isLoading = false;
    });
  }

  Future<void> _refreshNotificationAccess() async {
    final enabled = await _nativeBridge.isNotificationListenerEnabled();
    if (!mounted) return;
    setState(() => _notificationAccess = enabled);
  }

  Future<void> _handlePaired(RelayCredentials credentials) async {
    await _storage.save(credentials);
    await _nativeBridge.saveRelayCredentials(credentials);
    if (!mounted) return;
    setState(() => _credentials = credentials);
    await _refreshNotificationAccess();
  }

  Future<void> _disconnect() async {
    await _storage.clear();
    await _nativeBridge.clearRelayCredentials();
    if (!mounted) return;
    setState(() => _credentials = null);
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(
        body: Center(
          child: SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }

    return _credentials == null
        ? PairingScreen(deviceName: _deviceName, onPaired: _handlePaired)
        : DashboardScreen(
            credentials: _credentials!,
            notificationAccess: _notificationAccess,
            nativeBridge: _nativeBridge,
            onNotificationAccessChanged: _refreshNotificationAccess,
            onDisconnect: _disconnect,
          );
  }
}

class PairingScreen extends StatefulWidget {
  const PairingScreen({
    super.key,
    required this.deviceName,
    required this.onPaired,
  });

  final String deviceName;
  final ValueChanged<RelayCredentials> onPaired;

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final _manualCodeController = TextEditingController();
  bool _isPairing = false;
  String? _error;

  @override
  void dispose() {
    _manualCodeController.dispose();
    super.dispose();
  }

  Future<void> _pairFromRawValue(String rawValue) async {
    setState(() {
      _isPairing = true;
      _error = null;
    });

    try {
      final payload = PairingPayload.parse(rawValue);
      final credentials = await RelayClient.completePairing(
        pairing: payload,
        mobileDeviceName: widget.deviceName,
      );
      widget.onPaired(credentials);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString();
      });
    } finally {
      if (mounted) {
        setState(() => _isPairing = false);
      }
    }
  }

  Future<void> _openScanner() async {
    await Permission.camera.request();
    if (!mounted) return;
    final rawValue = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const PairingScannerScreen()),
    );
    if (rawValue?.trim().isNotEmpty == true) {
      await _pairFromRawValue(rawValue!);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 40),
          children: [
            const SizedBox(height: 12),
            const _Wordmark(),
            const SizedBox(height: 56),
            Text(
              'Pair this phone',
              style: Theme.of(context).textTheme.displaySmall,
            ),
            const SizedBox(height: 10),
            Text(
              'Open Relay Manager on your desktop, then scan the QR or paste the manual code below. Phone and PC need to be on the same Wi-Fi.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 28),
            FilledButton.icon(
              onPressed: _isPairing ? null : _openScanner,
              icon: const Icon(Icons.qr_code_scanner_outlined, size: 18),
              label: const Text('Scan QR'),
            ),
            const SizedBox(height: 22),
            const _SoftDivider(label: 'or'),
            const SizedBox(height: 22),
            TextField(
              controller: _manualCodeController,
              minLines: 3,
              maxLines: 5,
              style: const TextStyle(
                color: _Palette.text,
                fontSize: 13.5,
                fontFamily: 'monospace',
                height: 1.4,
              ),
              decoration: const InputDecoration(
                labelText: 'Manual code',
                hintText: 'http://192.168.x.x:39393|id|token',
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: _isPairing
                  ? null
                  : () => _pairFromRawValue(_manualCodeController.text),
              child: _isPairing
                  ? const SizedBox(
                      height: 16,
                      width: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Pair manually'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 18),
              _StatusBanner(
                icon: Icons.error_outline_rounded,
                title: 'Pairing failed',
                detail: _error!,
                tone: _BannerTone.error,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class PairingScannerScreen extends StatefulWidget {
  const PairingScannerScreen({super.key});

  @override
  State<PairingScannerScreen> createState() => _PairingScannerScreenState();
}

class _PairingScannerScreenState extends State<PairingScannerScreen> {
  final _controller = MobileScannerController();
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _handleDetect(BarcodeCapture capture) {
    if (_handled) return;
    final rawValue = capture.barcodes
        .map((barcode) => barcode.rawValue)
        .whereType<String>()
        .firstOrNull;
    if (rawValue == null || rawValue.trim().isEmpty) {
      return;
    }

    _handled = true;
    Navigator.of(context).pop(rawValue);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('Scan QR'),
        backgroundColor: Colors.black,
      ),
      body: Stack(
        children: [
          MobileScanner(controller: _controller, onDetect: _handleDetect),
          // Subtle viewfinder frame (no neon)
          Center(
            child: AspectRatio(
              aspectRatio: 1,
              child: Container(
                margin: const EdgeInsets.all(48),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(28),
                  border: Border.all(
                    color: Colors.white.withValues(alpha: 0.55),
                    width: 1,
                  ),
                ),
              ),
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(28, 0, 28, 36),
              child: Text(
                'Point at the Relay Manager QR.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Colors.white.withValues(alpha: 0.85),
                  fontSize: 13.5,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({
    super.key,
    required this.credentials,
    required this.notificationAccess,
    required this.nativeBridge,
    required this.onNotificationAccessChanged,
    required this.onDisconnect,
  });

  final RelayCredentials credentials;
  final bool notificationAccess;
  final NativeBridge nativeBridge;
  final Future<void> Function() onNotificationAccessChanged;
  final Future<void> Function() onDisconnect;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final _commandController = TextEditingController();
  final _noteController = TextEditingController();
  final _remoteKeyboardController = TextEditingController();
  final _localActivity = <ActivityItem>[];
  final _relayEvents = <RelayEvent>[];
  Timer? _clipboardTimer;
  Timer? _pollTimer;
  Timer? _secondScreenTimer;
  int _tabIndex = 0;
  bool _clipboardSyncEnabled = false;
  bool _trackpadOpen = false;
  bool _keyboardOpen = false;
  bool _keyboardLiveTyping = true;
  bool _suppressRemoteKeyboardChange = false;
  bool _isSendingCommand = false;
  bool _isPolling = false;
  bool _isUploadingFiles = false;
  bool _isPhoneCameraStreaming = false;
  bool _isPhoneCameraBusy = false;
  bool _secondScreenEnabled = false;
  String _phoneCameraFacing = 'front';
  String _lastClipboardSent = '';
  String _lastRemoteKeyboardText = '';
  String? _sendingDesktopAction;
  String? _pollError;
  String? _uploadStatus;
  String? _phoneCameraStatus;
  String? _secondScreenStatus;
  int _secondScreenTick = 0;
  DateTime _lastTrackpadMoveAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastTrackpadScrollAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastTrackpadZoomAt = DateTime.fromMillisecondsSinceEpoch(0);

  RelayClient get _client => RelayClient(credentials: widget.credentials);
  List<RelayEvent> get _commandEvents =>
      _relayEvents.where((event) => event.isCommandEvent).toList();
  RelayEvent? get _latestCommandStatus =>
      _commandEvents.where((event) => event.isCommandStatus).firstOrNull;
  List<RelayEvent> get _screenResultEvents =>
      _relayEvents.where((event) => event.isScreenResult).toList();
  RelayEvent? get _latestScreenResult => _screenResultEvents.firstOrNull;
  RelayEvent? get _latestNotification => _relayEvents
      .where((event) => event.eventType == 'notification')
      .firstOrNull;
  List<RelayEvent> get _fileEvents =>
      _relayEvents.where((event) => event.eventType == 'file').toList();
  RelayEvent? get _latestFile => _fileEvents.firstOrNull;

  @override
  void initState() {
    super.initState();
    _remoteKeyboardController.addListener(_handleRemoteKeyboardChanged);
    _pollEvents();
    _pollTimer = Timer.periodic(
      const Duration(seconds: 2),
      (_) => _pollEvents(),
    );
  }

  @override
  void dispose() {
    _clipboardTimer?.cancel();
    _pollTimer?.cancel();
    _secondScreenTimer?.cancel();
    unawaited(widget.nativeBridge.stopPhoneCameraStream());
    _commandController.dispose();
    _noteController.dispose();
    _remoteKeyboardController.dispose();
    super.dispose();
  }

  void _pushActivity(String title, String detail) {
    setState(() {
      _localActivity.insert(
        0,
        ActivityItem(title: title, detail: detail, createdAt: DateTime.now()),
      );
      if (_localActivity.length > 20) {
        _localActivity.removeRange(20, _localActivity.length);
      }
    });
  }

  Future<void> _pollEvents() async {
    if (_isPolling) {
      return;
    }

    _isPolling = true;
    try {
      final events = await _client.listEvents();
      if (!mounted) return;
      setState(() {
        _relayEvents
          ..clear()
          ..addAll(events);
        _pollError = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _pollError = error.toString());
    } finally {
      _isPolling = false;
    }
  }

  Future<void> _sendEvent(
    String eventType,
    Map<String, Object?> payload,
    String successTitle,
  ) async {
    try {
      await _client.sendEvent(eventType, payload);
      _pushActivity(
        successTitle,
        'Sent to ${widget.credentials.desktopDeviceName}',
      );
      unawaited(_pollEvents());
    } catch (error) {
      _pushActivity('Relay error', error.toString());
    }
  }

  Future<void> _sendRemoteInput(
    Map<String, Object?> payload, {
    bool silent = true,
  }) async {
    try {
      await _client.sendRemoteInput(payload);
      if (!silent) {
        _pushActivity(
          'Remote input',
          'Sent to ${widget.credentials.desktopDeviceName}',
        );
      }
    } catch (error) {
      if (!silent) {
        _pushActivity('Remote input failed', error.toString());
      }
    }
  }

  void _sendTrackpadDelta(Offset delta) {
    final now = DateTime.now();
    if (now.difference(_lastTrackpadMoveAt).inMilliseconds < 18) {
      return;
    }

    _lastTrackpadMoveAt = now;
    final dx = delta.dx * 1.6;
    final dy = delta.dy * 1.6;
    unawaited(
      _sendRemoteInput({'type': 'mouse_move_delta', 'dx': dx, 'dy': dy}),
    );
  }

  void _sendTrackpadScroll(Offset delta) {
    final now = DateTime.now();
    if (now.difference(_lastTrackpadScrollAt).inMilliseconds < 16) {
      return;
    }

    _lastTrackpadScrollAt = now;
    final deltaY = (delta.dy * 18).clamp(-1400.0, 1400.0).round();
    final deltaX = (delta.dx * 18).clamp(-1400.0, 1400.0).round();
    if (deltaY == 0 && deltaX == 0) {
      return;
    }

    unawaited(
      _sendRemoteInput({
        'type': 'mouse_scroll',
        'deltaY': deltaY,
        'deltaX': deltaX,
      }),
    );
  }

  void _sendTrackpadZoom(double delta) {
    final now = DateTime.now();
    if (now.difference(_lastTrackpadZoomAt).inMilliseconds < 160) {
      return;
    }

    _lastTrackpadZoomAt = now;
    _sendRemoteKey(delta > 0 ? 'ctrl+plus' : 'ctrl+minus');
  }

  void _sendRemoteClick({String button = 'left', bool isDouble = false}) {
    unawaited(
      _sendRemoteInput({
        'type': 'mouse_click',
        'button': button,
        'double': isDouble,
      }),
    );
  }

  void _sendRemoteScroll(int deltaY, {int deltaX = 0}) {
    unawaited(
      _sendRemoteInput({
        'type': 'mouse_scroll',
        'deltaY': deltaY,
        'deltaX': deltaX,
      }),
    );
  }

  Future<void> _sendRemoteKeyAndWait(String keys) {
    return _sendRemoteInput({'type': 'keyboard_press', 'keys': keys});
  }

  void _sendRemoteKey(String keys) {
    unawaited(_sendRemoteKeyAndWait(keys));
  }

  void _sendRemoteText(String text) {
    if (text.isEmpty) {
      return;
    }

    unawaited(_sendRemoteInput({'type': 'keyboard_type', 'text': text}));
  }

  Uri _desktopScreenFrameUri() {
    return _desktopScreenFrameUriFor(
      widget.credentials,
      _secondScreenTick,
      width: 1280,
    );
  }

  void _setSecondScreenEnabled(bool enabled) {
    _secondScreenTimer?.cancel();
    _secondScreenTimer = null;
    setState(() {
      _secondScreenEnabled = enabled;
      _secondScreenStatus = enabled
          ? 'Live desktop view is running.'
          : 'Second screen stopped.';
      if (enabled) {
        _secondScreenTick += 1;
      }
    });

    if (!enabled) {
      return;
    }

    _startSecondScreenTimer();
  }

  void _startSecondScreenTimer() {
    _secondScreenTimer?.cancel();
    _secondScreenTimer = Timer.periodic(const Duration(milliseconds: 280), (_) {
      if (!mounted || !_secondScreenEnabled) {
        return;
      }
      setState(() => _secondScreenTick += 1);
    });
  }

  Future<void> _sendSecondScreenClick(
    double normalizedX,
    double normalizedY, {
    String button = 'left',
    bool isDouble = false,
  }) async {
    await _sendRemoteInput({
      'type': 'mouse_click_absolute',
      'normalizedX': normalizedX.clamp(0.0, 1.0),
      'normalizedY': normalizedY.clamp(0.0, 1.0),
      'button': button,
      'double': isDouble,
    });
  }

  Future<void> _sendSecondScreenTap(
    Offset localPosition,
    Size surfaceSize, {
    String button = 'left',
    bool isDouble = false,
  }) async {
    if (surfaceSize.width <= 0 || surfaceSize.height <= 0) {
      return;
    }

    await _sendSecondScreenClick(
      localPosition.dx / surfaceSize.width,
      localPosition.dy / surfaceSize.height,
      button: button,
      isDouble: isDouble,
    );
  }

  void _openSecondScreenFullscreen() {
    if (!_secondScreenEnabled) {
      _setSecondScreenEnabled(true);
    }

    _secondScreenTimer?.cancel();
    _secondScreenTimer = null;
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => _SecondScreenFullscreenPage(
            credentials: widget.credentials,
            onTapScreen: (normalizedX, normalizedY, button, isDouble) =>
                _sendSecondScreenClick(
                  normalizedX,
                  normalizedY,
                  button: button,
                  isDouble: isDouble,
                ),
          ),
        ),
      ).whenComplete(() {
        if (!mounted || !_secondScreenEnabled) {
          return;
        }
        setState(() => _secondScreenTick += 1);
        _startSecondScreenTimer();
      }),
    );
  }

  void _handleRemoteKeyboardChanged() {
    if (_suppressRemoteKeyboardChange || !_keyboardLiveTyping) {
      _lastRemoteKeyboardText = _remoteKeyboardController.text;
      return;
    }

    final next = _remoteKeyboardController.text;
    final previous = _lastRemoteKeyboardText;
    if (next == previous) {
      return;
    }

    if (next.length > previous.length && next.startsWith(previous)) {
      _sendRemoteText(next.substring(previous.length));
    } else if (next.length < previous.length && previous.startsWith(next)) {
      final deleteCount = math.min(previous.length - next.length, 30);
      for (var index = 0; index < deleteCount; index += 1) {
        _sendRemoteKey('backspace');
      }
    }

    _lastRemoteKeyboardText = next;
  }

  Future<void> _clearRemoteKeyboardText({bool clearPc = true}) async {
    _suppressRemoteKeyboardChange = true;
    _remoteKeyboardController.clear();
    _lastRemoteKeyboardText = '';
    _suppressRemoteKeyboardChange = false;

    if (!clearPc) {
      return;
    }

    await _sendRemoteKeyAndWait('ctrl+a');
    await Future<void>.delayed(const Duration(milliseconds: 55));
    await _sendRemoteKeyAndWait('backspace');
  }

  Future<void> _sendClipboard({bool silent = false}) async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text?.trim() ?? '';
    if (text.isEmpty || text == _lastClipboardSent) {
      return;
    }

    _lastClipboardSent = text;
    await _sendEvent('clipboard', {
      'text': text,
      'sentAt': DateTime.now().toIso8601String(),
    }, silent ? 'Clipboard auto-synced' : 'Clipboard synced');
  }

  void _setClipboardSync(bool enabled) {
    setState(() => _clipboardSyncEnabled = enabled);
    _clipboardTimer?.cancel();
    if (!enabled) {
      return;
    }

    _clipboardTimer = Timer.periodic(
      const Duration(seconds: 3),
      (_) => _sendClipboard(silent: true),
    );
    _sendClipboard(silent: true);
  }

  Future<void> _sendCommand() async {
    final command = _commandController.text.trim();
    if (command.isEmpty) {
      _pushActivity('Command missing', 'Type what the desktop should do.');
      return;
    }

    setState(() => _isSendingCommand = true);
    final commandId = 'android-${DateTime.now().microsecondsSinceEpoch}';
    try {
      await _sendEvent('computer_command', {
        'commandId': commandId,
        'command': command,
        'requestedAt': DateTime.now().toIso8601String(),
        'source': 'android',
      }, 'Computer command sent');
      _commandController.clear();
    } finally {
      if (mounted) {
        setState(() => _isSendingCommand = false);
      }
    }
  }

  Future<void> _sendDesktopAction(String command) async {
    if (_sendingDesktopAction != null) {
      return;
    }

    final isAnalyze = command == 'analyze_screen';
    final commandId = 'android-action-${DateTime.now().microsecondsSinceEpoch}';
    setState(() => _sendingDesktopAction = command);
    try {
      await _sendEvent('desktop_command', {
        'commandId': commandId,
        'command': command,
        'requestedAt': DateTime.now().toIso8601String(),
        'source': 'android',
      }, isAnalyze ? 'Analyze screen sent' : 'Reset sent');
    } finally {
      if (mounted) {
        setState(() => _sendingDesktopAction = null);
      }
    }
  }

  Future<void> _sendNote() async {
    final note = _noteController.text.trim();
    if (note.isEmpty) {
      return;
    }

    await _sendEvent(
      note.startsWith('http://') || note.startsWith('https://')
          ? 'link'
          : 'note',
      note.startsWith('http://') || note.startsWith('https://')
          ? {
              'url': note,
              'title': 'Shared from Sylica Mobile',
              'sentAt': DateTime.now().toIso8601String(),
            }
          : {
              'text': note,
              'title': 'Mobile note',
              'sentAt': DateTime.now().toIso8601String(),
            },
      'Note sent',
    );
    _noteController.clear();
  }

  Future<void> _pickAndUploadFiles(_FilePickMode mode) async {
    if (_isUploadingFiles) {
      return;
    }

    setState(() {
      _isUploadingFiles = true;
      _uploadStatus = 'Opening picker…';
    });

    try {
      final files = switch (mode) {
        _FilePickMode.photos => await widget.nativeBridge.pickPhotos(),
        _FilePickMode.files => await widget.nativeBridge.pickFiles(),
        _FilePickMode.folder => await widget.nativeBridge.pickFolder(),
      };

      if (files.isEmpty) {
        _pushActivity('No files selected', 'Nothing was sent to the desktop.');
        return;
      }

      final batchId = 'android-${DateTime.now().millisecondsSinceEpoch}';
      final uploaded = <UploadedPhoneFile>[];
      for (var index = 0; index < files.length; index += 1) {
        final file = files[index];
        if (!mounted) return;
        setState(() {
          _uploadStatus =
              'Uploading ${index + 1}/${files.length}: ${file.name} (${_formatBytes(file.size)})';
        });
        uploaded.add(
          await _client.uploadFile(
            file,
            batchId: batchId,
            onProgress: (sentBytes, totalBytes) {
              if (!mounted) return;
              setState(() {
                _uploadStatus =
                    'Uploading ${index + 1}/${files.length}: ${file.name} '
                    '${_formatBytes(sentBytes)} / ${_formatBytes(totalBytes)}';
              });
            },
          ),
        );
      }

      final firstDirectory =
          uploaded.firstOrNull?.savedDirectory ?? 'Documents/Sylica';
      _pushActivity(
        uploaded.length == 1 ? 'File saved on PC' : 'Files saved on PC',
        '${uploaded.length} item${uploaded.length == 1 ? '' : 's'} saved to $firstDirectory',
      );
      await _pollEvents();
    } catch (error) {
      _pushActivity('File upload failed', error.toString());
    } finally {
      if (mounted) {
        setState(() {
          _isUploadingFiles = false;
          _uploadStatus = null;
        });
      }
    }
  }

  Future<void> _togglePhoneCameraStream() async {
    if (_isPhoneCameraBusy) {
      return;
    }

    setState(() {
      _isPhoneCameraBusy = true;
      _phoneCameraStatus = _isPhoneCameraStreaming
          ? 'Stopping phone webcam...'
          : 'Starting phone webcam...';
    });

    try {
      if (_isPhoneCameraStreaming) {
        await widget.nativeBridge.stopPhoneCameraStream();
        if (!mounted) return;
        setState(() {
          _isPhoneCameraStreaming = false;
          _phoneCameraStatus = 'Phone webcam stopped.';
        });
        _pushActivity('Phone webcam stopped', 'Camera stream is off.');
        return;
      }

      final permission = await Permission.camera.request();
      if (!permission.isGranted) {
        throw const RelayException('Camera permission is required.');
      }

      await widget.nativeBridge.startPhoneCameraStream(
        widget.credentials,
        facing: _phoneCameraFacing,
        width: 960,
        height: 540,
        fps: 6,
      );

      if (!mounted) return;
      setState(() {
        _isPhoneCameraStreaming = true;
        _phoneCameraStatus =
            'Streaming ${_phoneCameraFacing == 'front' ? 'front' : 'back'} camera to desktop.';
      });
      _pushActivity(
        'Phone webcam live',
        'Desktop can preview the live camera feed now.',
      );
      unawaited(_pollEvents());
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _isPhoneCameraStreaming = false;
        _phoneCameraStatus = error.toString();
      });
      _pushActivity('Phone webcam failed', error.toString());
    } finally {
      if (mounted) {
        setState(() => _isPhoneCameraBusy = false);
      }
    }
  }

  Future<void> _switchPhoneCameraFacing() async {
    if (_isPhoneCameraBusy) {
      return;
    }

    final nextFacing = _phoneCameraFacing == 'front' ? 'back' : 'front';
    setState(() => _phoneCameraFacing = nextFacing);

    if (!_isPhoneCameraStreaming) {
      return;
    }

    await widget.nativeBridge.stopPhoneCameraStream();
    if (!mounted) return;
    setState(() {
      _isPhoneCameraStreaming = false;
      _phoneCameraStatus = 'Switching to $nextFacing camera...';
    });
    await _togglePhoneCameraStream();
  }

  void _goToTab(int index) {
    setState(() {
      _tabIndex = index;
      if (index != 2) {
        _trackpadOpen = false;
        _keyboardOpen = false;
      }
    });
  }

  void _openActivityPage() {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => Scaffold(
            backgroundColor: _Palette.bg,
            appBar: AppBar(
              backgroundColor: _Palette.bg,
              surfaceTintColor: Colors.transparent,
              title: const Text('History'),
              actions: [
                IconButton(
                  tooltip: 'Refresh',
                  onPressed: _pollEvents,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
            body: _buildActivityPage(showHeading: false),
          ),
        ),
      ),
    );
  }

  static const _tabs = <_NavTab>[
    _NavTab(label: 'Home', icon: Icons.circle_outlined),
    _NavTab(label: 'Assist', icon: Icons.auto_awesome_outlined),
    _NavTab(label: 'Screen', icon: Icons.screenshot_monitor_outlined),
    _NavTab(label: 'Share', icon: Icons.ios_share_outlined),
  ];

  @override
  Widget build(BuildContext context) {
    final pages = [
      _buildOverviewPage(),
      _buildCommandPage(),
      _buildSecondScreenPage(),
      _buildSharePage(),
    ];

    return Scaffold(
      backgroundColor: _Palette.bg,
      body: Material(
        color: _Palette.bg,
        child: Stack(
          children: [
            SafeArea(
              bottom: false,
              child: Column(
                mainAxisSize: MainAxisSize.max,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _AppHeader(
                    title: _tabs[_tabIndex].label,
                    connected: _pollError == null,
                    onRefresh: _pollEvents,
                    onActivity: _openActivityPage,
                    onDisconnect: widget.onDisconnect,
                  ),
                  Expanded(
                    child: IndexedStack(
                      index: _tabIndex,
                      sizing: StackFit.expand,
                      children: pages,
                    ),
                  ),
                ],
              ),
            ),
            if (_tabIndex == 2) _buildRemoteTrackpadOverlay(context),
            if (_tabIndex == 2) _buildRemoteKeyboardOverlay(context),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBarTheme(
        data: NavigationBarThemeData(
          backgroundColor: _Palette.bg,
          surfaceTintColor: Colors.transparent,
          indicatorColor: _Palette.surfaceHi,
          labelTextStyle: WidgetStatePropertyAll(
            const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w500,
              color: _Palette.text,
            ),
          ),
          iconTheme: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.selected)) {
              return const IconThemeData(color: _Palette.text, size: 22);
            }
            return const IconThemeData(color: _Palette.textFaint, size: 22);
          }),
        ),
        child: NavigationBar(
          height: 64,
          selectedIndex: _tabIndex,
          onDestinationSelected: _goToTab,
          labelBehavior: NavigationDestinationLabelBehavior.onlyShowSelected,
          destinations: const [
            NavigationDestination(
              icon: Icon(Icons.home_outlined),
              selectedIcon: Icon(Icons.home_rounded),
              label: 'Home',
            ),
            NavigationDestination(
              icon: Icon(Icons.auto_awesome_outlined),
              selectedIcon: Icon(Icons.auto_awesome_rounded),
              label: 'Assist',
            ),
            NavigationDestination(
              icon: Icon(Icons.screenshot_monitor_outlined),
              selectedIcon: Icon(Icons.screenshot_monitor_rounded),
              label: 'Screen',
            ),
            NavigationDestination(
              icon: Icon(Icons.ios_share_outlined),
              selectedIcon: Icon(Icons.ios_share_rounded),
              label: 'Share',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRemoteTrackpadOverlay(BuildContext context) {
    final width = math.min(MediaQuery.of(context).size.width * 0.7, 292.0);
    return AnimatedPositioned(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      left: 0,
      bottom: 12,
      width: _trackpadOpen ? width : 34,
      height: _trackpadOpen ? 392 : 126,
      child: _trackpadOpen
          ? _RemotePanel(
              side: _RemotePanelSide.left,
              title: 'Trackpad',
              onToggle: () => setState(() => _trackpadOpen = false),
              child: Column(
                children: [
                  Expanded(
                    child: _RemoteTrackpadSurface(
                      onMove: _sendTrackpadDelta,
                      onScroll: _sendTrackpadScroll,
                      onClick: () => _sendRemoteClick(),
                      onDoubleClick: () => _sendRemoteClick(isDouble: true),
                      onRightClick: () => _sendRemoteClick(button: 'right'),
                      onZoom: _sendTrackpadZoom,
                      onShortcut: _sendRemoteKey,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: _RemoteChip(
                          label: 'Left',
                          onTap: () => _sendRemoteClick(),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: _RemoteChip(
                          label: 'Right',
                          onTap: () => _sendRemoteClick(button: 'right'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: _RemoteChip(
                          label: 'Double',
                          onTap: () => _sendRemoteClick(isDouble: true),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: _RemoteChip(
                          label: 'Scroll up',
                          onTap: () => _sendRemoteScroll(520),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: _RemoteChip(
                          label: 'Scroll down',
                          onTap: () => _sendRemoteScroll(-720),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            )
          : _RemoteCollapsedHandle(
              side: _RemotePanelSide.left,
              label: 'Pad',
              icon: Icons.touch_app_outlined,
              onTap: () => setState(() {
                _trackpadOpen = true;
                _keyboardOpen = false;
              }),
            ),
    );
  }

  Widget _buildRemoteKeyboardOverlay(BuildContext context) {
    final width = math.min(MediaQuery.of(context).size.width * 0.78, 334.0);
    return AnimatedPositioned(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      right: 0,
      bottom: 12,
      width: _keyboardOpen ? width : 34,
      height: _keyboardOpen ? 452 : 136,
      child: _keyboardOpen
          ? _RemotePanel(
              side: _RemotePanelSide.right,
              title: 'Remote keyboard',
              onToggle: () => setState(() => _keyboardOpen = false),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextField(
                    controller: _remoteKeyboardController,
                    minLines: 3,
                    maxLines: 4,
                    autofocus: true,
                    style: const TextStyle(
                      color: _Palette.text,
                      fontSize: 14,
                      height: 1.35,
                    ),
                    decoration: const InputDecoration(
                      hintText: 'Type here to send to PC...',
                    ),
                  ),
                  const SizedBox(height: 8),
                  _SettingRow(
                    title: 'Live typing',
                    detail: 'Characters go to the PC as you type.',
                    trailing: Switch(
                      value: _keyboardLiveTyping,
                      onChanged: (value) {
                        setState(() => _keyboardLiveTyping = value);
                        _lastRemoteKeyboardText =
                            _remoteKeyboardController.text;
                      },
                    ),
                  ),
                  Row(
                    children: [
                      Expanded(
                        child: _RemoteChip(
                          label: 'Send text',
                          onTap: () {
                            _sendRemoteText(_remoteKeyboardController.text);
                            unawaited(_clearRemoteKeyboardText(clearPc: false));
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: _RemoteChip(
                          label: 'Clear',
                          onTap: () => unawaited(_clearRemoteKeyboardText()),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _RemoteKeyChip('Enter', 'enter', _sendRemoteKey),
                      _RemoteKeyChip('Back', 'backspace', _sendRemoteKey),
                      _RemoteKeyChip('Tab', 'tab', _sendRemoteKey),
                      _RemoteKeyChip('Esc', 'escape', _sendRemoteKey),
                      _RemoteKeyChip('Ctrl A', 'ctrl+a', _sendRemoteKey),
                      _RemoteKeyChip('Ctrl C', 'ctrl+c', _sendRemoteKey),
                      _RemoteKeyChip('Ctrl V', 'ctrl+v', _sendRemoteKey),
                      _RemoteKeyChip('Alt Tab', 'alt+tab', _sendRemoteKey),
                      _RemoteKeyChip('Up', 'up', _sendRemoteKey),
                      _RemoteKeyChip('Down', 'down', _sendRemoteKey),
                      _RemoteKeyChip('Left', 'left', _sendRemoteKey),
                      _RemoteKeyChip('Right', 'right', _sendRemoteKey),
                    ],
                  ),
                ],
              ),
            )
          : _RemoteCollapsedHandle(
              side: _RemotePanelSide.right,
              label: 'Keys',
              icon: Icons.keyboard_alt_outlined,
              onTap: () => setState(() {
                _keyboardOpen = true;
                _trackpadOpen = false;
              }),
            ),
    );
  }

  Widget _buildOverviewPage() {
    final liveStatus = _latestCommandStatus?.status.toLowerCase() ?? '';
    final isLive =
        liveStatus == 'running' ||
        liveStatus == 'starting' ||
        liveStatus == 'queued';

    return _PageScaffold(
      children: [
        _GreetingHeader(
          deviceName: widget.credentials.desktopDeviceName,
          isLive: isLive,
          isOnline: _pollError == null,
        ),
        const SizedBox(height: 20),
        _LiveStrip(
          latest: _latestCommandStatus,
          commandEventCount: _commandEvents.length,
          pollError: _pollError,
          onTap: () => _goToTab(1),
        ),
        const SizedBox(height: 24),
        _ActionRow(
          label: 'Analyze screen',
          detail: 'Read the PC screen now.',
          onTap: () => unawaited(_sendDesktopAction('analyze_screen')),
        ),
        _ActionRow(
          label: 'Ask desktop AI',
          detail: 'Run a task from your phone.',
          onTap: () => _goToTab(1),
        ),
        _ActionRow(
          label: 'Remote screen',
          detail: 'View and tap-control the PC.',
          onTap: () => _goToTab(2),
        ),
        _ActionRow(
          label: 'Share',
          detail: 'Files, notes, clipboard, webcam.',
          onTap: () => _goToTab(3),
          isLast: true,
        ),
        if (_latestScreenResult != null ||
            _latestFile != null ||
            _latestNotification != null) ...[
          const SizedBox(height: 28),
          const _SectionLabel('Latest'),
          const SizedBox(height: 12),
          if (_latestScreenResult != null)
            _AnswerResultCard(event: _latestScreenResult!),
          if (_latestFile != null) _RelayEventTile(event: _latestFile!),
          if (_latestNotification != null)
            _RelayEventTile(event: _latestNotification!),
        ],
      ],
    );
  }

  Widget _buildCommandPage() {
    return _PageScaffold(
      children: [
        Text('Assist', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: _sendingDesktopAction == null
                    ? () => unawaited(_sendDesktopAction('analyze_screen'))
                    : null,
                icon: const Icon(Icons.screen_search_desktop_rounded, size: 18),
                label: Text(
                  _sendingDesktopAction == 'analyze_screen'
                      ? 'Sending...'
                      : 'Analyze screen',
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _sendingDesktopAction == null
                    ? () => unawaited(_sendDesktopAction('reset'))
                    : null,
                icon: const Icon(Icons.restart_alt_rounded, size: 18),
                label: Text(
                  _sendingDesktopAction == 'reset' ? 'Sending...' : 'Reset',
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        TextField(
          controller: _commandController,
          minLines: 2,
          maxLines: 4,
          style: const TextStyle(
            color: _Palette.text,
            fontSize: 14.5,
            height: 1.45,
          ),
          decoration: const InputDecoration(
            hintText: 'Tell the desktop what to do...',
          ),
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: _isSendingCommand ? null : _sendCommand,
          icon: const Icon(Icons.arrow_forward_rounded, size: 18),
          label: Text(_isSendingCommand ? 'Sending...' : 'Run'),
        ),
        _LiveStrip(
          latest: _latestCommandStatus,
          commandEventCount: _commandEvents.length,
          pollError: _pollError,
        ),
        if (_latestScreenResult != null) ...[
          const SizedBox(height: 24),
          const _SectionLabel('Answer'),
          const SizedBox(height: 12),
          _AnswerResultCard(event: _latestScreenResult!),
        ],
        if (_commandEvents.isNotEmpty) ...[
          const SizedBox(height: 24),
          _GhostButton(
            label: 'Open history',
            icon: Icons.history_rounded,
            onTap: _openActivityPage,
          ),
        ],
      ],
    );
  }

  Widget _buildSecondScreenPage() {
    final screenUri = _desktopScreenFrameUri();

    return _PageScaffold(
      children: [
        Text('Screen', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: () => _setSecondScreenEnabled(!_secondScreenEnabled),
                icon: Icon(
                  _secondScreenEnabled
                      ? Icons.stop_rounded
                      : Icons.play_arrow_rounded,
                  size: 18,
                ),
                label: Text(_secondScreenEnabled ? 'Stop view' : 'Start view'),
              ),
            ),
            const SizedBox(width: 10),
            IconButton.filledTonal(
              onPressed: _openSecondScreenFullscreen,
              tooltip: 'Full screen',
              icon: const Icon(Icons.fullscreen_rounded, size: 22),
            ),
            const SizedBox(width: 10),
            IconButton.outlined(
              onPressed: () => setState(() => _secondScreenTick += 1),
              tooltip: 'Refresh',
              icon: const Icon(Icons.refresh_rounded, size: 18),
            ),
          ],
        ),
        const SizedBox(height: 18),
        ClipRRect(
          borderRadius: BorderRadius.circular(22),
          child: Container(
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.32),
              border: Border.all(color: _Palette.hairline),
              borderRadius: BorderRadius.circular(22),
            ),
            child: AspectRatio(
              aspectRatio: 16 / 9,
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final surfaceSize = constraints.biggest;
                  return GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTapUp: _secondScreenEnabled
                        ? (details) => unawaited(
                            _sendSecondScreenTap(
                              details.localPosition,
                              surfaceSize,
                            ),
                          )
                        : null,
                    onDoubleTapDown: _secondScreenEnabled
                        ? (details) => unawaited(
                            _sendSecondScreenTap(
                              details.localPosition,
                              surfaceSize,
                              isDouble: true,
                            ),
                          )
                        : null,
                    onLongPressStart: _secondScreenEnabled
                        ? (details) => unawaited(
                            _sendSecondScreenTap(
                              details.localPosition,
                              surfaceSize,
                              button: 'right',
                            ),
                          )
                        : null,
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        if (_secondScreenEnabled)
                          Image.network(
                            screenUri.toString(),
                            fit: BoxFit.fill,
                            gaplessPlayback: true,
                            errorBuilder: (context, error, stackTrace) {
                              return Center(
                                child: Padding(
                                  padding: const EdgeInsets.all(18),
                                  child: Text(
                                    'Cannot load desktop screen. Make sure the desktop app is running and both devices are on the same Wi-Fi.',
                                    textAlign: TextAlign.center,
                                    style: Theme.of(
                                      context,
                                    ).textTheme.bodySmall,
                                  ),
                                ),
                              );
                            },
                          )
                        else
                          const Center(
                            child: Text(
                              'Start view to mirror your desktop here',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: _Palette.textMuted,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        Positioned(
                          left: 10,
                          top: 10,
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 6,
                            ),
                            decoration: BoxDecoration(
                              color: Colors.black.withValues(alpha: 0.58),
                              borderRadius: BorderRadius.circular(999),
                              border: Border.all(color: _Palette.hairline),
                            ),
                            child: Text(
                              _secondScreenEnabled ? 'Live' : 'Paused',
                              style: const TextStyle(
                                color: _Palette.text,
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
          ),
        ),
        const SizedBox(height: 12),
        const _InlineHint(
          icon: Icons.touch_app_outlined,
          text: 'Tap to click. Double tap or long press also work.',
        ),
        if (_secondScreenStatus != null) ...[
          const SizedBox(height: 12),
          _InlineHint(
            icon: Icons.screenshot_monitor_outlined,
            text: _secondScreenStatus!,
          ),
        ],
      ],
    );
  }

  Widget _buildSharePage() {
    return _PageScaffold(
      children: [
        Text('Share', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 16),
        if (!widget.notificationAccess) ...[
          _StatusBanner(
            icon: Icons.notifications_off_outlined,
            title: 'Enable notifications',
            detail: 'One Android permission unlocks notification relay.',
            tone: _BannerTone.warning,
            actionLabel: 'Open',
            onAction: () async {
              await widget.nativeBridge.openNotificationListenerSettings();
              await widget.onNotificationAccessChanged();
            },
          ),
          const SizedBox(height: 18),
        ],
        _FileRow(
          icon: _isPhoneCameraStreaming
              ? Icons.videocam_rounded
              : Icons.videocam_outlined,
          title: _isPhoneCameraStreaming ? 'Stop webcam' : 'Phone webcam',
          detail: _isPhoneCameraStreaming
              ? 'Live ${_phoneCameraFacing == 'front' ? 'front' : 'back'} camera'
              : 'Use phone camera on PC',
          busy: _isPhoneCameraBusy,
          onTap: _togglePhoneCameraStream,
        ),
        _FileRow(
          icon: Icons.flip_camera_android_outlined,
          title: 'Switch camera',
          detail: _phoneCameraFacing == 'front'
              ? 'Using front camera'
              : 'Using back camera',
          busy: _isPhoneCameraBusy,
          onTap: _switchPhoneCameraFacing,
        ),
        _FileRow(
          icon: Icons.photo_outlined,
          title: 'Photos',
          detail: 'Send images',
          busy: _isUploadingFiles,
          onTap: () => _pickAndUploadFiles(_FilePickMode.photos),
        ),
        _FileRow(
          icon: Icons.description_outlined,
          title: 'Files',
          detail: 'Docs, PDFs, anything',
          busy: _isUploadingFiles,
          onTap: () => _pickAndUploadFiles(_FilePickMode.files),
        ),
        _FileRow(
          icon: Icons.folder_open_outlined,
          title: 'Folder',
          detail: 'Send a folder',
          busy: _isUploadingFiles,
          onTap: () => _pickAndUploadFiles(_FilePickMode.folder),
          isLast: true,
        ),
        if (_phoneCameraStatus != null) ...[
          const SizedBox(height: 12),
          _InlineHint(
            icon: _isPhoneCameraStreaming
                ? Icons.videocam_rounded
                : Icons.videocam_off_outlined,
            text: _phoneCameraStatus!,
          ),
        ],
        if (_uploadStatus != null) ...[
          const SizedBox(height: 12),
          _InlineHint(
            icon: Icons.cloud_upload_outlined,
            text: _uploadStatus!,
          ),
        ],
        const SizedBox(height: 28),
        const _SectionLabel('Text'),
        const SizedBox(height: 12),
        _SettingRow(
          title: 'Clipboard sync',
          detail: _clipboardSyncEnabled ? 'On while app is open' : 'Off',
          trailing: Switch(
            value: _clipboardSyncEnabled,
            onChanged: _setClipboardSync,
          ),
        ),
        const SizedBox(height: 8),
        _GhostButton(
          label: 'Send clipboard',
          icon: Icons.content_paste_outlined,
          onTap: () => _sendClipboard(),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _noteController,
          minLines: 3,
          maxLines: 6,
          style: const TextStyle(color: _Palette.text, fontSize: 14.5),
          decoration: const InputDecoration(hintText: 'Note or link...'),
        ),
        const SizedBox(height: 12),
        _GhostButton(
          label: 'Send note',
          icon: Icons.north_east_rounded,
          onTap: _sendNote,
        ),
        if (_latestFile != null) ...[
          const SizedBox(height: 28),
          const _SectionLabel('Latest file'),
          const SizedBox(height: 12),
          _RelayEventTile(event: _latestFile!),
        ],
      ],
    );
  }

  Widget _buildActivityPage({bool showHeading = true}) {
    final mixedEvents = [
      ..._relayEvents.map(
        (event) => ActivityItem(
          title: event.title,
          detail: event.detail,
          createdAt: event.createdAt ?? DateTime.now(),
        ),
      ),
      ..._localActivity,
    ]..sort((left, right) => right.createdAt.compareTo(left.createdAt));

    return _PageScaffold(
      children: [
        if (showHeading) ...[
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Text(
                  'History',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
              ),
              IconButton(
                tooltip: 'Refresh',
                onPressed: _pollEvents,
                icon: const Icon(Icons.refresh_rounded, size: 19),
              ),
            ],
          ),
          const SizedBox(height: 12),
        ],
        if (_pollError != null) ...[
          const SizedBox(height: 18),
          _StatusBanner(
            icon: Icons.wifi_tethering_off_rounded,
            title: 'Reconnecting',
            detail: _pollError!,
            tone: _BannerTone.warning,
          ),
        ],
        const SizedBox(height: 22),
        if (mixedEvents.isEmpty)
          const _Empty(message: 'Quiet for now.')
        else
          ...mixedEvents.take(40).map((item) => _ActivityTile(item: item)),
      ],
    );
  }
}

// ─── Layout primitives ────────────────────────────────────────────

class _SecondScreenFullscreenPage extends StatefulWidget {
  const _SecondScreenFullscreenPage({
    required this.credentials,
    required this.onTapScreen,
  });

  final RelayCredentials credentials;
  final Future<void> Function(
    double normalizedX,
    double normalizedY,
    String button,
    bool isDouble,
  )
  onTapScreen;

  @override
  State<_SecondScreenFullscreenPage> createState() =>
      _SecondScreenFullscreenPageState();
}

class _SecondScreenFullscreenPageState
    extends State<_SecondScreenFullscreenPage> {
  Timer? _timer;
  int _tick = 0;
  String? _status;

  @override
  void initState() {
    super.initState();
    unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky));
    _timer = Timer.periodic(const Duration(milliseconds: 220), (_) {
      if (!mounted) {
        return;
      }
      setState(() => _tick += 1);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge));
    super.dispose();
  }

  Uri get _screenUri =>
      _desktopScreenFrameUriFor(widget.credentials, _tick, width: 1600);

  Future<void> _clickAt(
    Offset localPosition,
    Size surfaceSize, {
    String button = 'left',
    bool isDouble = false,
  }) async {
    if (surfaceSize.width <= 0 || surfaceSize.height <= 0) {
      return;
    }

    HapticFeedback.selectionClick();
    setState(
      () => _status = isDouble
          ? 'Double click sent'
          : button == 'right'
          ? 'Right click sent'
          : 'Click sent',
    );
    await widget.onTapScreen(
      (localPosition.dx / surfaceSize.width).clamp(0.0, 1.0),
      (localPosition.dy / surfaceSize.height).clamp(0.0, 1.0),
      button,
      isDouble,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          LayoutBuilder(
            builder: (context, constraints) {
              final surfaceSize = constraints.biggest;
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapUp: (details) =>
                    unawaited(_clickAt(details.localPosition, surfaceSize)),
                onDoubleTapDown: (details) => unawaited(
                  _clickAt(
                    details.localPosition,
                    surfaceSize,
                    isDouble: true,
                  ),
                ),
                onLongPressStart: (details) => unawaited(
                  _clickAt(
                    details.localPosition,
                    surfaceSize,
                    button: 'right',
                  ),
                ),
                child: Image.network(
                  _screenUri.toString(),
                  fit: BoxFit.fill,
                  gaplessPlayback: true,
                  errorBuilder: (context, error, stackTrace) {
                    return Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          'Cannot load desktop screen. Keep desktop app running on the same Wi-Fi.',
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ),
                    );
                  },
                ),
              );
            },
          ),
          Positioned(
            left: 14,
            top: 14,
            child: SafeArea(
              child: IconButton.filledTonal(
                onPressed: () => Navigator.of(context).pop(),
                tooltip: 'Exit full screen',
                icon: const Icon(Icons.close_fullscreen_rounded),
              ),
            ),
          ),
          Positioned(
            right: 14,
            top: 14,
            child: SafeArea(
              child: IconButton.filledTonal(
                onPressed: () => setState(() => _tick += 1),
                tooltip: 'Refresh',
                icon: const Icon(Icons.refresh_rounded),
              ),
            ),
          ),
          Positioned(
            left: 18,
            right: 18,
            bottom: 18,
            child: SafeArea(
              child: Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 7,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.56),
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: _Palette.hairline),
                  ),
                  child: Text(
                    _status ??
                        'Full screen live view: tap to click, double tap, long press for right click',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: _Palette.text,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

enum _RemotePanelSide { left, right }

class _RemoteTrackpadSurface extends StatefulWidget {
  const _RemoteTrackpadSurface({
    required this.onMove,
    required this.onScroll,
    required this.onClick,
    required this.onDoubleClick,
    required this.onRightClick,
    required this.onZoom,
    required this.onShortcut,
  });

  final void Function(Offset delta) onMove;
  final void Function(Offset delta) onScroll;
  final VoidCallback onClick;
  final VoidCallback onDoubleClick;
  final VoidCallback onRightClick;
  final void Function(double delta) onZoom;
  final void Function(String keys) onShortcut;

  @override
  State<_RemoteTrackpadSurface> createState() => _RemoteTrackpadSurfaceState();
}

class _RemoteTrackpadSurfaceState extends State<_RemoteTrackpadSurface> {
  final _points = <int, Offset>{};
  final _downPositions = <int, Offset>{};
  Timer? _singleTapTimer;
  DateTime? _lastTapAt;
  DateTime? _gestureStartedAt;
  DateTime _lastThreeFingerGestureAt = DateTime.fromMillisecondsSinceEpoch(0);
  Offset? _lastTapPosition;
  Offset? _centroid;
  Offset? _gestureStartCentroid;
  double? _pinchDistance;
  double _maxGestureMovement = 0;
  int _maxPointerCount = 0;
  bool _suppressTapUntilEmpty = false;

  @override
  void dispose() {
    _singleTapTimer?.cancel();
    super.dispose();
  }

  Offset _currentCentroid() {
    if (_points.isEmpty) {
      return Offset.zero;
    }

    var dx = 0.0;
    var dy = 0.0;
    for (final point in _points.values) {
      dx += point.dx;
      dy += point.dy;
    }

    return Offset(dx / _points.length, dy / _points.length);
  }

  double? _currentPinchDistance() {
    if (_points.length < 2) {
      return null;
    }

    final values = _points.values.take(2).toList(growable: false);
    return (values[0] - values[1]).distance;
  }

  void _handlePointerDown(PointerDownEvent event) {
    if (_points.isEmpty) {
      _gestureStartedAt = DateTime.now();
      _gestureStartCentroid = event.localPosition;
      _maxGestureMovement = 0;
      _maxPointerCount = 0;
      _suppressTapUntilEmpty = false;
      _pinchDistance = null;
    }

    _points[event.pointer] = event.localPosition;
    _downPositions[event.pointer] = event.localPosition;
    _maxPointerCount = math.max(_maxPointerCount, _points.length);
    _centroid = _currentCentroid();
    _gestureStartCentroid ??= _centroid;

    if (_points.length >= 2) {
      _singleTapTimer?.cancel();
      _lastTapAt = null;
      _lastTapPosition = null;
      _pinchDistance = _currentPinchDistance();
    }
  }

  void _handlePointerMove(PointerMoveEvent event) {
    if (!_points.containsKey(event.pointer)) {
      return;
    }

    _points[event.pointer] = event.localPosition;
    final currentCentroid = _currentCentroid();
    final previousCentroid = _centroid ?? currentCentroid;
    final centroidDelta = currentCentroid - previousCentroid;
    _centroid = currentCentroid;
    _maxGestureMovement = math.max(
      _maxGestureMovement,
      (currentCentroid - (_gestureStartCentroid ?? currentCentroid)).distance,
    );

    if (_points.length == 1 && _maxPointerCount == 1) {
      widget.onMove(event.delta);
      return;
    }

    if (_points.length == 2) {
      widget.onScroll(centroidDelta);
      final nextDistance = _currentPinchDistance();
      final previousDistance = _pinchDistance;
      if (nextDistance != null && previousDistance != null) {
        final pinchDelta = nextDistance - previousDistance;
        if (pinchDelta.abs() > 10) {
          widget.onZoom(pinchDelta);
          _pinchDistance = nextDistance;
        }
      } else {
        _pinchDistance = nextDistance;
      }
      return;
    }

    if (_points.length >= 3) {
      _handleThreeFingerGesture(
        currentCentroid - (_gestureStartCentroid ?? currentCentroid),
      );
    }
  }

  void _handlePointerUp(PointerUpEvent event) {
    final pointerCountBeforeUp = _points.length;
    final gestureDuration = DateTime.now().difference(
      _gestureStartedAt ?? DateTime.now(),
    );
    final downPosition = _downPositions[event.pointer] ?? event.localPosition;
    final pointerTravel = (event.localPosition - downPosition).distance;

    if (!_suppressTapUntilEmpty &&
        pointerCountBeforeUp == 2 &&
        _maxPointerCount == 2 &&
        _maxGestureMovement < 11 &&
        gestureDuration.inMilliseconds < 340) {
      _suppressTapUntilEmpty = true;
      HapticFeedback.selectionClick();
      widget.onRightClick();
    } else if (!_suppressTapUntilEmpty &&
        pointerCountBeforeUp == 1 &&
        _maxPointerCount == 1 &&
        pointerTravel < 13 &&
        gestureDuration.inMilliseconds < 280) {
      _queueSingleOrDoubleTap(event.localPosition);
    }

    _removePointer(event.pointer);
  }

  void _handlePointerCancel(PointerCancelEvent event) {
    _removePointer(event.pointer);
  }

  void _queueSingleOrDoubleTap(Offset position) {
    final now = DateTime.now();
    final lastTapAt = _lastTapAt;
    final lastTapPosition = _lastTapPosition;
    final isDoubleTap =
        lastTapAt != null &&
        lastTapPosition != null &&
        now.difference(lastTapAt).inMilliseconds < 300 &&
        (position - lastTapPosition).distance < 26;

    if (isDoubleTap) {
      _singleTapTimer?.cancel();
      _lastTapAt = null;
      _lastTapPosition = null;
      HapticFeedback.selectionClick();
      widget.onDoubleClick();
      return;
    }

    _lastTapAt = now;
    _lastTapPosition = position;
    _singleTapTimer?.cancel();
    _singleTapTimer = Timer(const Duration(milliseconds: 210), () {
      _lastTapAt = null;
      _lastTapPosition = null;
      HapticFeedback.selectionClick();
      widget.onClick();
    });
  }

  void _handleThreeFingerGesture(Offset totalDelta) {
    final now = DateTime.now();
    if (now.difference(_lastThreeFingerGestureAt).inMilliseconds < 560) {
      return;
    }

    final absX = totalDelta.dx.abs();
    final absY = totalDelta.dy.abs();
    if (math.max(absX, absY) < 46) {
      return;
    }

    _lastThreeFingerGestureAt = now;
    _gestureStartCentroid = _centroid;
    _suppressTapUntilEmpty = true;
    HapticFeedback.mediumImpact();

    if (absX > absY) {
      widget.onShortcut(totalDelta.dx > 0 ? 'alt+tab' : 'shift+alt+tab');
      return;
    }

    widget.onShortcut(totalDelta.dy < 0 ? 'win+tab' : 'win+d');
  }

  void _removePointer(int pointer) {
    _points.remove(pointer);
    _downPositions.remove(pointer);

    if (_points.isEmpty) {
      _centroid = null;
      _gestureStartCentroid = null;
      _pinchDistance = null;
      _maxGestureMovement = 0;
      _maxPointerCount = 0;
      _suppressTapUntilEmpty = false;
      _gestureStartedAt = null;
      return;
    }

    _centroid = _currentCentroid();
    _gestureStartCentroid = _centroid;
    _pinchDistance = _currentPinchDistance();
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: _handlePointerDown,
      onPointerMove: _handlePointerMove,
      onPointerUp: _handlePointerUp,
      onPointerCancel: _handlePointerCancel,
      child: Container(
        width: double.infinity,
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: _Palette.hairline),
        ),
        child: const Center(
          child: Text(
            '1 finger move / tap\n2 fingers scroll, pinch, right tap\n3 fingers switch apps',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: _Palette.textMuted,
              fontSize: 12.2,
              height: 1.42,
            ),
          ),
        ),
      ),
    );
  }
}

class _RemotePanel extends StatelessWidget {
  const _RemotePanel({
    required this.side,
    required this.title,
    required this.onToggle,
    required this.child,
  });

  final _RemotePanelSide side;
  final String title;
  final VoidCallback onToggle;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.horizontal(
      left: side == _RemotePanelSide.right
          ? const Radius.circular(22)
          : Radius.zero,
      right: side == _RemotePanelSide.left
          ? const Radius.circular(22)
          : Radius.zero,
    );

    return Material(
      color: Colors.transparent,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: _Palette.bg.withValues(alpha: 0.96),
          borderRadius: radius,
          border: Border.all(color: _Palette.hairline),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.28),
              blurRadius: 28,
              offset: const Offset(0, 12),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    title,
                    style: const TextStyle(
                      color: _Palette.text,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  onPressed: onToggle,
                  icon: Icon(
                    side == _RemotePanelSide.left
                        ? Icons.chevron_left_rounded
                        : Icons.chevron_right_rounded,
                    color: _Palette.textMuted,
                    size: 20,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Expanded(child: child),
          ],
        ),
      ),
    );
  }
}

class _RemoteCollapsedHandle extends StatelessWidget {
  const _RemoteCollapsedHandle({
    required this.side,
    required this.label,
    required this.icon,
    required this.onTap,
  });

  final _RemotePanelSide side;
  final String label;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.horizontal(
      left: side == _RemotePanelSide.right
          ? const Radius.circular(18)
          : Radius.zero,
      right: side == _RemotePanelSide.left
          ? const Radius.circular(18)
          : Radius.zero,
    );

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: radius,
        child: Container(
          decoration: BoxDecoration(
            color: _Palette.surfaceHi.withValues(alpha: 0.92),
            borderRadius: radius,
            border: Border.all(color: _Palette.hairline),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 17, color: _Palette.brand),
              const SizedBox(height: 8),
              RotatedBox(
                quarterTurns: side == _RemotePanelSide.left ? 3 : 1,
                child: Text(
                  label,
                  style: const TextStyle(
                    color: _Palette.text,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.4,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RemoteChip extends StatelessWidget {
  const _RemoteChip({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        decoration: BoxDecoration(
          color: _Palette.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: _Palette.hairlineSoft),
        ),
        child: Text(
          label,
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: _Palette.text,
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _RemoteKeyChip extends StatelessWidget {
  const _RemoteKeyChip(this.label, this.keys, this.onPressed);

  final String label;
  final String keys;
  final void Function(String keys) onPressed;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => onPressed(keys),
      borderRadius: BorderRadius.circular(999),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: _Palette.surface,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: _Palette.hairlineSoft),
        ),
        child: Text(
          label,
          style: const TextStyle(
            color: _Palette.text,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _PageScaffold extends StatelessWidget {
  const _PageScaffold({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 8, 22, 28),
      physics: const BouncingScrollPhysics(),
      children: children,
    );
  }
}

class _AppHeader extends StatelessWidget {
  const _AppHeader({
    required this.title,
    required this.connected,
    required this.onRefresh,
    required this.onActivity,
    required this.onDisconnect,
  });

  final String title;
  final bool connected;
  final VoidCallback onRefresh;
  final VoidCallback onActivity;
  final VoidCallback onDisconnect;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 14, 12, 8),
      child: Row(
        children: [
          const _Wordmark(small: true),
          const SizedBox(width: 10),
          Text(
            title,
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const Spacer(),
          _StatusDot(active: connected),
          const SizedBox(width: 4),
          IconButton(
            tooltip: 'Refresh',
            onPressed: onRefresh,
            icon: const Icon(Icons.sync_rounded, size: 19),
          ),
          IconButton(
            tooltip: 'History',
            onPressed: onActivity,
            icon: const Icon(Icons.history_rounded, size: 18),
          ),
          IconButton(
            tooltip: 'Disconnect',
            onPressed: onDisconnect,
            icon: const Icon(Icons.logout_rounded, size: 18),
          ),
        ],
      ),
    );
  }
}

class _Wordmark extends StatelessWidget {
  const _Wordmark({this.small = false});

  final bool small;

  @override
  Widget build(BuildContext context) {
    final size = small ? 22.0 : 28.0;
    return Row(
      children: [
        SizedBox(
          width: size,
          height: size,
          child: CustomPaint(painter: _SylicaGlyph()),
        ),
        const SizedBox(width: 9),
        Text(
          'Sylica',
          style: TextStyle(
            color: _Palette.text,
            fontSize: small ? 16 : 20,
            fontWeight: FontWeight.w600,
            letterSpacing: -0.4,
          ),
        ),
      ],
    );
  }
}

class _SylicaGlyph extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final radius = size.shortestSide / 2;
    final center = Offset(size.width / 2, size.height / 2);

    final outer = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4
      ..strokeCap = StrokeCap.round
      ..color = _Palette.brand;

    final innerArc = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4
      ..strokeCap = StrokeCap.round
      ..color = _Palette.brand.withValues(alpha: 0.55);

    canvas.drawCircle(center, radius - 0.6, outer);

    // Subtle "S" curve inside
    final path = Path()
      ..moveTo(center.dx - radius * 0.35, center.dy + radius * 0.36)
      ..quadraticBezierTo(
        center.dx + radius * 0.4,
        center.dy + radius * 0.05,
        center.dx - radius * 0.05,
        center.dy - radius * 0.05,
      )
      ..quadraticBezierTo(
        center.dx - radius * 0.5,
        center.dy - radius * 0.1,
        center.dx + radius * 0.35,
        center.dy - radius * 0.36,
      );
    canvas.drawPath(path, innerArc);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _SoftDivider extends StatelessWidget {
  const _SoftDivider({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const Expanded(child: Divider(color: _Palette.hairline, height: 1)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(
            label.toUpperCase(),
            style: const TextStyle(
              color: _Palette.textFaint,
              fontSize: 10.5,
              letterSpacing: 1.4,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
        const Expanded(child: Divider(color: _Palette.hairline, height: 1)),
      ],
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: const TextStyle(
        color: _Palette.textFaint,
        fontSize: 10.5,
        letterSpacing: 1.4,
        fontWeight: FontWeight.w600,
      ),
    );
  }
}

// ─── Bottom navigation ────────────────────────────────────────────

class _NavTab {
  const _NavTab({required this.label, required this.icon});
  final String label;
  final IconData icon;
}

// ─── Home / overview widgets ──────────────────────────────────────

class _GreetingHeader extends StatelessWidget {
  const _GreetingHeader({
    required this.deviceName,
    required this.isLive,
    required this.isOnline,
  });

  final String deviceName;
  final bool isLive;
  final bool isOnline;

  @override
  Widget build(BuildContext context) {
    final hour = DateTime.now().hour;
    final greeting = hour < 5
        ? 'Late night'
        : hour < 12
        ? 'Good morning'
        : hour < 18
        ? 'Good afternoon'
        : 'Good evening';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(greeting, style: Theme.of(context).textTheme.bodyMedium),
        const SizedBox(height: 4),
        Text(
          'Linked to $deviceName',
          style: Theme.of(context).textTheme.displaySmall,
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            _StatusDot(active: isOnline),
            const SizedBox(width: 6),
            Text(
              isOnline ? 'Connected' : 'Reconnecting...',
              style: const TextStyle(
                color: _Palette.textMuted,
                fontSize: 12.5,
                fontFamily: 'monospace',
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (isLive) ...[
              const SizedBox(width: 12),
              const _PulseDot(color: _Palette.brand),
              const SizedBox(width: 6),
              const Text(
                'live',
                style: TextStyle(
                  color: _Palette.brand,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.active});
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: active ? _Palette.brand : _Palette.warn,
      ),
    );
  }
}

class _PulseDot extends StatefulWidget {
  const _PulseDot({required this.color});
  final Color color;

  @override
  State<_PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<_PulseDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (context, _) {
        final t = (math.sin(_ctrl.value * math.pi * 2) + 1) / 2;
        return Stack(
          alignment: Alignment.center,
          children: [
            Opacity(
              opacity: 0.18 + 0.18 * (1 - t),
              child: Container(
                width: 14 + 4 * t,
                height: 14 + 4 * t,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: widget.color,
                ),
              ),
            ),
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: widget.color,
              ),
            ),
          ],
        );
      },
    );
  }
}

class _LiveStrip extends StatelessWidget {
  const _LiveStrip({
    required this.latest,
    required this.commandEventCount,
    required this.pollError,
    this.onTap,
  });

  final RelayEvent? latest;
  final int commandEventCount;
  final String? pollError;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final status = latest?.status.toLowerCase() ?? '';
    final isActive =
        status == 'running' || status == 'starting' || status == 'queued';
    final hasError = pollError != null;

    final accent = hasError
        ? _Palette.warn
        : isActive
        ? _Palette.brand
        : _Palette.textFaint;

    final title = hasError
        ? 'Reconnecting'
        : latest?.title ?? 'No desktop task running';
    final detail =
        pollError ??
        latest?.detail ??
        'Ready for a desktop task.';

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 18),
        decoration: BoxDecoration(
          color: _Palette.surface,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 3,
              height: 38,
              margin: const EdgeInsets.only(top: 4, right: 14),
              decoration: BoxDecoration(
                color: accent,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          title,
                          style: Theme.of(context).textTheme.titleMedium,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (latest != null && latest!.stepCount > 0 && !hasError)
                        Text(
                          'step ${latest!.stepCount}',
                          style: Theme.of(context).textTheme.labelSmall,
                        ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    detail,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  if (latest?.needsSecretInput == true) ...[
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        const Icon(
                          Icons.lock_outline_rounded,
                          size: 14,
                          color: _Palette.warn,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          'Manual secret needed on desktop',
                          style: TextStyle(
                            color: _Palette.warn,
                            fontSize: 12,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ],
                    ),
                  ],
                  if (commandEventCount > 0 && !hasError) ...[
                    const SizedBox(height: 8),
                    Text(
                      '$commandEventCount update${commandEventCount == 1 ? '' : 's'}',
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ],
                ],
              ),
            ),
            if (onTap != null)
              const Padding(
                padding: EdgeInsets.only(left: 8, top: 6),
                child: Icon(
                  Icons.arrow_forward_rounded,
                  size: 16,
                  color: _Palette.textFaint,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({
    required this.label,
    required this.detail,
    required this.onTap,
    this.isLast = false,
  });

  final String label;
  final String detail;
  final VoidCallback onTap;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: isLast ? Colors.transparent : _Palette.hairlineSoft,
              width: 1,
            ),
          ),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: const TextStyle(
                      color: _Palette.text,
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      letterSpacing: -0.1,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    detail,
                    style: const TextStyle(
                      color: _Palette.textMuted,
                      fontSize: 13,
                      height: 1.35,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            const Icon(
              Icons.arrow_forward_rounded,
              size: 16,
              color: _Palette.textFaint,
            ),
          ],
        ),
      ),
    );
  }
}

class _FileRow extends StatelessWidget {
  const _FileRow({
    required this.icon,
    required this.title,
    required this.detail,
    required this.busy,
    required this.onTap,
    this.isLast = false,
  });

  final IconData icon;
  final String title;
  final String detail;
  final bool busy;
  final VoidCallback onTap;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: busy ? null : onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 16),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: isLast ? Colors.transparent : _Palette.hairlineSoft,
              width: 1,
            ),
          ),
        ),
        child: Row(
          children: [
            Icon(icon, size: 20, color: _Palette.textMuted),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      color: _Palette.text,
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    detail,
                    style: const TextStyle(
                      color: _Palette.textMuted,
                      fontSize: 12.5,
                      height: 1.35,
                    ),
                  ),
                ],
              ),
            ),
            if (busy)
              const SizedBox(
                height: 14,
                width: 14,
                child: CircularProgressIndicator(strokeWidth: 1.6),
              )
            else
              const Icon(
                Icons.arrow_forward_rounded,
                size: 16,
                color: _Palette.textFaint,
              ),
          ],
        ),
      ),
    );
  }
}

class _SettingRow extends StatelessWidget {
  const _SettingRow({
    required this.title,
    required this.detail,
    required this.trailing,
  });

  final String title;
  final String detail;
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: _Palette.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  detail,
                  style: const TextStyle(
                    color: _Palette.textMuted,
                    fontSize: 12.5,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
          trailing,
        ],
      ),
    );
  }
}

class _GhostButton extends StatelessWidget {
  const _GhostButton({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: _Palette.surface,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: _Palette.textMuted),
            const SizedBox(width: 9),
            Text(
              label,
              style: const TextStyle(
                color: _Palette.text,
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AnswerResultCard extends StatelessWidget {
  const _AnswerResultCard({required this.event});

  final RelayEvent event;

  @override
  Widget build(BuildContext context) {
    final question = event.resultQuestion;
    final answer = event.resultAnswer.isNotEmpty
        ? event.resultAnswer
        : event.detail;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _Palette.surfaceHi,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _Palette.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.auto_awesome_rounded,
                color: _Palette.brand,
                size: 17,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  event.title,
                  style: const TextStyle(
                    color: _Palette.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (event.createdAt != null)
                Text(
                  _formatClock(event.createdAt!),
                  style: const TextStyle(
                    color: _Palette.textFaint,
                    fontSize: 11,
                  ),
                ),
            ],
          ),
          if (question.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(
              question,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: _Palette.textMuted,
                fontSize: 12.5,
                height: 1.4,
              ),
            ),
          ],
          const SizedBox(height: 14),
          SelectableText(
            answer,
            style: const TextStyle(
              color: _Palette.text,
              fontSize: 14,
              height: 1.42,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

class _RelayEventTile extends StatelessWidget {
  const _RelayEventTile({required this.event});

  final RelayEvent event;

  @override
  Widget build(BuildContext context) {
    final isFile = event.eventType == 'file';
    final isStatus = event.isCommandStatus;
    final isResult = event.isScreenResult;
    final icon = isFile
        ? Icons.folder_outlined
        : isResult
        ? Icons.auto_awesome_rounded
        : isStatus
        ? Icons.radio_button_checked_outlined
        : Icons.notifications_none_rounded;

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: _Palette.hairlineSoft, width: 1),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: _Palette.textMuted),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  event.title,
                  style: const TextStyle(
                    color: _Palette.text,
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  event.detail,
                  style: const TextStyle(
                    color: _Palette.textMuted,
                    fontSize: 12.5,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
          if (event.createdAt != null) ...[
            const SizedBox(width: 8),
            Text(
              _formatClock(event.createdAt!),
              style: const TextStyle(color: _Palette.textFaint, fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }
}

class _ActivityTile extends StatelessWidget {
  const _ActivityTile({required this.item});

  final ActivityItem item;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: _Palette.hairlineSoft, width: 1),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 5,
            height: 5,
            margin: const EdgeInsets.only(top: 7),
            decoration: const BoxDecoration(
              color: _Palette.textMuted,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.title,
                  style: const TextStyle(
                    color: _Palette.text,
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  item.detail,
                  style: const TextStyle(
                    color: _Palette.textMuted,
                    fontSize: 12.5,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            _formatClock(item.createdAt),
            style: const TextStyle(color: _Palette.textFaint, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Center(
        child: Text(
          message,
          style: const TextStyle(color: _Palette.textFaint, fontSize: 13),
        ),
      ),
    );
  }
}

class _InlineHint extends StatelessWidget {
  const _InlineHint({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 15, color: _Palette.textFaint),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: _Palette.textMuted,
              fontSize: 12.5,
              height: 1.35,
            ),
          ),
        ),
      ],
    );
  }
}

enum _BannerTone { success, warning, error }

class _StatusBanner extends StatelessWidget {
  const _StatusBanner({
    required this.icon,
    required this.title,
    required this.detail,
    required this.tone,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final String detail;
  final _BannerTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;

  Color get _accent => switch (tone) {
    _BannerTone.success => _Palette.brand,
    _BannerTone.warning => _Palette.warn,
    _BannerTone.error => _Palette.danger,
  };

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
      decoration: BoxDecoration(
        color: _Palette.surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 3,
            height: 38,
            margin: const EdgeInsets.only(right: 14, top: 2),
            decoration: BoxDecoration(
              color: _accent,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(icon, size: 16, color: _accent),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        title,
                        style: const TextStyle(
                          color: _Palette.text,
                          fontSize: 14.5,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  detail,
                  style: const TextStyle(
                    color: _Palette.textMuted,
                    fontSize: 13,
                    height: 1.4,
                  ),
                ),
                if (actionLabel != null && onAction != null) ...[
                  const SizedBox(height: 10),
                  OutlinedButton(
                    onPressed: onAction,
                    child: Text(actionLabel!),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

String _formatClock(DateTime value) {
  final local = value.toLocal();
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}

String _formatBytes(int value) {
  if (value < 1024) return '$value B';
  if (value < 1024 * 1024) return '${(value / 1024).toStringAsFixed(1)} KB';
  if (value < 1024 * 1024 * 1024) {
    return '${(value / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  return '${(value / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
}

enum _FilePickMode { photos, files, folder }

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    final iterator = this.iterator;
    if (iterator.moveNext()) {
      return iterator.current;
    }
    return null;
  }
}
