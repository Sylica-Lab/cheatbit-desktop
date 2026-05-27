import 'package:flutter/services.dart';

import 'relay_models.dart';

class NativeBridge {
  static const _channel = MethodChannel('com.sylica.mobile/native');

  Future<String> getDeviceName() async {
    final value = await _channel.invokeMethod<String>('getDeviceName');
    return value?.trim().isNotEmpty == true ? value!.trim() : 'Sylica Mobile';
  }

  Future<bool> isNotificationListenerEnabled() async {
    final value = await _channel.invokeMethod<bool>(
      'isNotificationListenerEnabled',
    );
    return value ?? false;
  }

  Future<void> openNotificationListenerSettings() async {
    await _channel.invokeMethod<void>('openNotificationListenerSettings');
  }

  Future<void> saveRelayCredentials(RelayCredentials credentials) async {
    await _channel.invokeMethod<void>('saveRelayCredentials', {
      'apiBaseUrl': credentials.apiBaseUrl,
      'pairingId': credentials.pairingId,
      'deviceToken': credentials.deviceToken,
      'mobileDeviceName': credentials.mobileDeviceName,
    });
  }

  Future<void> clearRelayCredentials() async {
    await _channel.invokeMethod<void>('clearRelayCredentials');
  }

  Future<void> startPhoneCameraStream(
    RelayCredentials credentials, {
    String facing = 'front',
    int width = 960,
    int height = 540,
    int fps = 6,
  }) async {
    await _channel.invokeMethod<void>('startPhoneCameraStream', {
      'apiBaseUrl': credentials.apiBaseUrl,
      'pairingId': credentials.pairingId,
      'deviceToken': credentials.deviceToken,
      'facing': facing,
      'width': width,
      'height': height,
      'fps': fps,
    });
  }

  Future<void> stopPhoneCameraStream() async {
    await _channel.invokeMethod<void>('stopPhoneCameraStream');
  }

  Future<List<PickedPhoneFile>> pickFiles() async {
    return _pickPhoneFiles('pickFiles');
  }

  Future<List<PickedPhoneFile>> pickPhotos() async {
    return _pickPhoneFiles('pickPhotos');
  }

  Future<List<PickedPhoneFile>> pickFolder() async {
    return _pickPhoneFiles('pickFolder');
  }

  Future<List<PickedPhoneFile>> _pickPhoneFiles(String method) async {
    final value = await _channel.invokeMethod<List<dynamic>>(method);
    return (value ?? const [])
        .whereType<Map<dynamic, dynamic>>()
        .map(PickedPhoneFile.fromJson)
        .where((file) => file.path.trim().isNotEmpty)
        .toList();
  }
}
