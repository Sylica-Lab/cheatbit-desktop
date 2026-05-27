import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'relay_models.dart';

class RelayException implements Exception {
  const RelayException(this.message);

  final String message;

  @override
  String toString() => message;
}

class RelayClient {
  RelayClient({required this.credentials, http.Client? httpClient})
    : _httpClient = httpClient;

  final RelayCredentials credentials;
  final http.Client? _httpClient;

  static Future<RelayCredentials> completePairing({
    required PairingPayload pairing,
    required String mobileDeviceName,
  }) async {
    final response = await http.post(
      _uri(pairing.apiBaseUrl, '/api/pairings/complete'),
      headers: const {'Content-Type': 'application/json; charset=utf-8'},
      body: jsonEncode({
        'pairingId': pairing.pairingId,
        'pairingToken': pairing.pairingToken,
        'mobileDeviceName': mobileDeviceName,
      }),
    );

    final data = _decodeResponse(response);
    final pairingSummary = data['pairing'];
    return RelayCredentials(
      apiBaseUrl: _readString(data, 'apiBaseUrl', fallback: pairing.apiBaseUrl),
      pairingId: pairingSummary is Map<String, dynamic>
          ? _readString(pairingSummary, 'id', fallback: pairing.pairingId)
          : pairing.pairingId,
      deviceToken: _readString(data, 'deviceToken'),
      mobileDeviceName: pairingSummary is Map<String, dynamic>
          ? _readString(
              pairingSummary,
              'mobileDeviceName',
              fallback: mobileDeviceName,
            )
          : mobileDeviceName,
      desktopDeviceName: pairingSummary is Map<String, dynamic>
          ? _readString(
              pairingSummary,
              'desktopDeviceName',
              fallback: 'Sylica AI Desktop',
            )
          : 'Sylica AI Desktop',
    );
  }

  Future<void> sendEvent(String eventType, Map<String, Object?> payload) async {
    final uri = _uri(credentials.apiBaseUrl, '/api/events');
    final headers = const {'Content-Type': 'application/json; charset=utf-8'};
    final body = jsonEncode({
      'pairingId': credentials.pairingId,
      'deviceToken': credentials.deviceToken,
      'eventType': eventType,
      'payload': payload,
    });
    final response = _httpClient == null
        ? await http.post(uri, headers: headers, body: body)
        : await _httpClient.post(uri, headers: headers, body: body);

    _decodeResponse(response);
  }

  Future<void> sendRemoteInput(Map<String, Object?> payload) async {
    final uri = _uri(credentials.apiBaseUrl, '/api/remote-input');
    final headers = const {'Content-Type': 'application/json; charset=utf-8'};
    final body = jsonEncode({
      'pairingId': credentials.pairingId,
      'deviceToken': credentials.deviceToken,
      'payload': payload,
    });
    final response = _httpClient == null
        ? await http.post(uri, headers: headers, body: body)
        : await _httpClient.post(uri, headers: headers, body: body);

    _decodeResponse(response);
  }

  Future<List<RelayEvent>> listEvents({DateTime? after}) async {
    final query = <String, String>{
      'pairingId': credentials.pairingId,
      'deviceToken': credentials.deviceToken,
      if (after != null) 'after': after.toUtc().toIso8601String(),
    };
    final baseUri = _uri(credentials.apiBaseUrl, '/api/events');
    final uri = baseUri.replace(queryParameters: query);
    final response = _httpClient == null
        ? await http.get(uri)
        : await _httpClient.get(uri);
    final data = _decodeResponse(response);
    final events = data['events'];
    if (events is! List) {
      return const [];
    }

    return events
        .whereType<Map<String, dynamic>>()
        .map(RelayEvent.fromJson)
        .toList();
  }

  Future<UploadedPhoneFile> uploadFile(
    PickedPhoneFile file, {
    required String batchId,
    void Function(int sentBytes, int totalBytes)? onProgress,
  }) async {
    final sourceFile = File(file.path);
    if (!await sourceFile.exists()) {
      throw RelayException(
        'Selected file is no longer available: ${file.name}',
      );
    }

    final uri = _uri(credentials.apiBaseUrl, '/api/files').replace(
      queryParameters: {
        'pairingId': credentials.pairingId,
        'deviceToken': credentials.deviceToken,
        'fileName': file.name,
        'relativePath': file.relativePath,
        'mimeType': file.mimeType,
        'batchId': batchId,
      },
    );
    final totalBytes = await sourceFile.length();
    final request = http.StreamedRequest('POST', uri);
    request.headers['Content-Type'] = file.mimeType.trim().isNotEmpty
        ? file.mimeType
        : 'application/octet-stream';
    request.contentLength = totalBytes;

    final client = _httpClient ?? http.Client();
    try {
      final responseFuture = client
          .send(request)
          .timeout(
            const Duration(minutes: 10),
            onTimeout: () => throw const RelayException(
              'Desktop did not accept the upload. Check that PC and phone are on the same Wi-Fi.',
            ),
          );

      var sentBytes = 0;
      final uploadStream = sourceFile.openRead().map((chunk) {
        sentBytes += chunk.length;
        onProgress?.call(sentBytes, totalBytes);
        return chunk;
      });

      await request.sink
          .addStream(uploadStream)
          .timeout(
            const Duration(minutes: 5),
            onTimeout: () => throw const RelayException(
              'Upload timed out while reading the selected file.',
            ),
          );
      await request.sink.close();

      final streamedResponse = await responseFuture;
      final response = await http.Response.fromStream(streamedResponse).timeout(
        const Duration(seconds: 30),
        onTimeout: () => throw const RelayException(
          'Desktop saved the upload but did not return a response in time.',
        ),
      );
      final data = _decodeResponse(response);
      final fileData = data['file'];
      if (fileData is! Map<String, dynamic>) {
        throw const RelayException(
          'Desktop did not return saved file details.',
        );
      }
      return UploadedPhoneFile.fromJson(fileData);
    } finally {
      if (_httpClient == null) {
        client.close();
      }
    }
  }

  static Uri _uri(String apiBaseUrl, String path) {
    final trimmed = apiBaseUrl.trim().replaceFirst(RegExp(r'/$'), '');
    return Uri.parse('$trimmed$path');
  }

  static Map<String, dynamic> _decodeResponse(http.Response response) {
    final body = response.body.trim();
    final decoded = body.isEmpty ? <String, dynamic>{} : jsonDecode(body);
    final data = decoded is Map<String, dynamic>
        ? decoded
        : <String, dynamic>{};

    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = data['error'];
      throw RelayException(
        error is String && error.trim().isNotEmpty
            ? error.trim()
            : 'Desktop relay returned ${response.statusCode}.',
      );
    }

    return data;
  }

  static String _readString(
    Map<String, dynamic> data,
    String key, {
    String fallback = '',
  }) {
    final value = data[key];
    if (value is String && value.trim().isNotEmpty) {
      return value.trim();
    }

    if (fallback.trim().isNotEmpty) {
      return fallback.trim();
    }

    throw RelayException('Desktop response is missing $key.');
  }
}
