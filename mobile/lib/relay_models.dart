import 'dart:convert';

class PairingPayload {
  const PairingPayload({
    required this.apiBaseUrl,
    required this.pairingId,
    required this.pairingToken,
  });

  final String apiBaseUrl;
  final String pairingId;
  final String pairingToken;

  static PairingPayload parse(String rawValue) {
    final raw = rawValue.trim();
    if (raw.isEmpty) {
      throw const FormatException('Pairing code is empty.');
    }

    if (raw.startsWith('{')) {
      final parsed = jsonDecode(raw);
      if (parsed is! Map<String, dynamic>) {
        throw const FormatException('Pairing QR is invalid.');
      }

      if (parsed['type'] != 'sylica-local-phone-relay') {
        throw const FormatException('This is not a Sylica local pairing QR.');
      }

      return PairingPayload(
        apiBaseUrl: _readString(parsed, 'apiBaseUrl'),
        pairingId: _readString(parsed, 'pairingId'),
        pairingToken: _readString(parsed, 'pairingToken'),
      );
    }

    final parts = raw.split('|').map((part) => part.trim()).toList();
    if (parts.length != 3) {
      throw const FormatException(
        'Manual code must be API URL, pairing ID, and token.',
      );
    }

    return PairingPayload(
      apiBaseUrl: parts[0],
      pairingId: parts[1],
      pairingToken: parts[2],
    );
  }

  static String _readString(Map<String, dynamic> data, String key) {
    final value = data[key];
    if (value is String && value.trim().isNotEmpty) {
      return value.trim();
    }

    throw FormatException('Pairing payload is missing $key.');
  }
}

class RelayCredentials {
  const RelayCredentials({
    required this.apiBaseUrl,
    required this.pairingId,
    required this.deviceToken,
    required this.mobileDeviceName,
    required this.desktopDeviceName,
  });

  final String apiBaseUrl;
  final String pairingId;
  final String deviceToken;
  final String mobileDeviceName;
  final String desktopDeviceName;

  Map<String, String> toStorage() {
    return {
      'apiBaseUrl': apiBaseUrl,
      'pairingId': pairingId,
      'deviceToken': deviceToken,
      'mobileDeviceName': mobileDeviceName,
      'desktopDeviceName': desktopDeviceName,
    };
  }

  static RelayCredentials? fromStorage(Map<String, String> values) {
    final apiBaseUrl = values['apiBaseUrl']?.trim() ?? '';
    final pairingId = values['pairingId']?.trim() ?? '';
    final deviceToken = values['deviceToken']?.trim() ?? '';
    if (apiBaseUrl.isEmpty || pairingId.isEmpty || deviceToken.isEmpty) {
      return null;
    }

    return RelayCredentials(
      apiBaseUrl: apiBaseUrl,
      pairingId: pairingId,
      deviceToken: deviceToken,
      mobileDeviceName: values['mobileDeviceName']?.trim().isNotEmpty == true
          ? values['mobileDeviceName']!.trim()
          : 'Sylica Mobile',
      desktopDeviceName: values['desktopDeviceName']?.trim().isNotEmpty == true
          ? values['desktopDeviceName']!.trim()
          : 'Sylica AI Desktop',
    );
  }
}

class ActivityItem {
  const ActivityItem({
    required this.title,
    required this.detail,
    required this.createdAt,
  });

  final String title;
  final String detail;
  final DateTime createdAt;
}

class PickedPhoneFile {
  const PickedPhoneFile({
    required this.path,
    required this.name,
    required this.relativePath,
    required this.mimeType,
    required this.size,
  });

  final String path;
  final String name;
  final String relativePath;
  final String mimeType;
  final int size;

  static PickedPhoneFile fromJson(Map<dynamic, dynamic> json) {
    return PickedPhoneFile(
      path: '${json['path'] ?? ''}',
      name: '${json['name'] ?? 'phone-upload'}',
      relativePath: '${json['relativePath'] ?? json['name'] ?? 'phone-upload'}',
      mimeType: '${json['mimeType'] ?? 'application/octet-stream'}',
      size: int.tryParse('${json['size'] ?? 0}') ?? 0,
    );
  }
}

class UploadedPhoneFile {
  const UploadedPhoneFile({
    required this.originalFileName,
    required this.savedFileName,
    required this.savedPath,
    required this.savedDirectory,
    required this.size,
  });

  final String originalFileName;
  final String savedFileName;
  final String savedPath;
  final String savedDirectory;
  final int size;

  static UploadedPhoneFile fromJson(Map<String, dynamic> json) {
    return UploadedPhoneFile(
      originalFileName: '${json['originalFileName'] ?? ''}',
      savedFileName: '${json['savedFileName'] ?? ''}',
      savedPath: '${json['savedPath'] ?? ''}',
      savedDirectory: '${json['savedDirectory'] ?? ''}',
      size: int.tryParse('${json['size'] ?? 0}') ?? 0,
    );
  }
}

class RelayEvent {
  const RelayEvent({
    required this.id,
    required this.pairingId,
    required this.source,
    required this.eventType,
    required this.payload,
    required this.createdAt,
    required this.mobileDeviceName,
  });

  final String id;
  final String pairingId;
  final String source;
  final String eventType;
  final Map<String, dynamic> payload;
  final DateTime? createdAt;
  final String mobileDeviceName;

  bool get isCommandEvent =>
      eventType == 'computer_command' ||
      eventType == 'computer_command_status' ||
      eventType == 'desktop_command' ||
      eventType == 'desktop_command_status' ||
      eventType == 'screen_result';

  bool get isCommandStatus =>
      eventType == 'computer_command_status' ||
      eventType == 'desktop_command_status';

  String get title {
    return switch (eventType) {
      'clipboard' => 'Clipboard',
      'notification' => 'Notification',
      'computer_command' => 'Command sent',
      'computer_command_status' => _payloadString(
        'status',
        fallback: 'Command update',
      ),
      'desktop_command' => _desktopCommandLabel(),
      'desktop_command_status' => _payloadString(
        'status',
        fallback: 'Desktop update',
      ),
      'screen_result' => 'Answer ready',
      'file' => 'File saved',
      'link' => 'Link',
      'note' => 'Note',
      'otp' => 'OTP',
      _ => eventType,
    };
  }

  String get detail {
    if (eventType == 'computer_command_status' ||
        eventType == 'desktop_command_status') {
      return _payloadString('message', fallback: 'Desktop task updated.');
    }

    if (eventType == 'computer_command' || eventType == 'desktop_command') {
      if (eventType == 'desktop_command') {
        return _desktopCommandLabel();
      }

      return _payloadString('command', fallback: 'Computer command');
    }

    if (eventType == 'screen_result') {
      return _payloadString(
        'answer',
        fallback: _payloadString('code', fallback: 'Generated answer'),
      );
    }

    if (eventType == 'notification') {
      final appName = _payloadString('appName');
      final notificationTitle = _payloadString('title');
      final text = _payloadString('text');
      return [
        appName,
        notificationTitle,
        text,
      ].where((value) => value.isNotEmpty).join(' - ');
    }

    if (eventType == 'file') {
      final fileName = _payloadString(
        'savedFileName',
        fallback: _payloadString('originalFileName', fallback: 'Phone file'),
      );
      final savedDirectory = _payloadString('savedDirectory');
      return savedDirectory.isEmpty
          ? fileName
          : '$fileName saved to $savedDirectory';
    }

    if (eventType == 'clipboard') {
      return _payloadString('text', fallback: 'Clipboard text');
    }

    if (eventType == 'link') {
      return _payloadString(
        'title',
        fallback: _payloadString('url', fallback: 'Shared link'),
      );
    }

    if (eventType == 'otp') {
      final label = _payloadString('label');
      final code = _payloadString('code');
      return label.isNotEmpty ? '$label: $code' : code;
    }

    return _payloadString('text', fallback: 'Relay event');
  }

  String get status => _payloadString('status');
  int get stepCount => int.tryParse('${payload['stepCount'] ?? ''}') ?? 0;
  bool get needsSecretInput => payload['needsSecretInput'] == true;
  bool get isScreenResult => eventType == 'screen_result';
  String get resultQuestion => _payloadString('question');
  String get resultAnswer =>
      _payloadString('answer', fallback: _payloadString('code'));

  static RelayEvent fromJson(Map<String, dynamic> json) {
    final payload = json['payload'];
    final pairing = json['pairing'];
    final createdAt = json['createdAt'];
    return RelayEvent(
      id: '${json['id'] ?? ''}',
      pairingId: '${json['pairingId'] ?? ''}',
      source: '${json['source'] ?? ''}',
      eventType: '${json['eventType'] ?? ''}',
      payload: payload is Map<String, dynamic> ? payload : <String, dynamic>{},
      createdAt: createdAt is String ? DateTime.tryParse(createdAt) : null,
      mobileDeviceName: pairing is Map<String, dynamic>
          ? '${pairing['mobileDeviceName'] ?? 'Mobile device'}'
          : 'Mobile device',
    );
  }

  String _payloadString(String key, {String fallback = ''}) {
    final value = payload[key];
    return value is String && value.trim().isNotEmpty ? value.trim() : fallback;
  }

  String _desktopCommandLabel() {
    return switch (_payloadString('command')) {
      'analyze_screen' => 'Analyze screen',
      'reset' => 'Reset desktop',
      _ => 'Desktop command',
    };
  }
}
