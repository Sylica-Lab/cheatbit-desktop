import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'relay_models.dart';

class RelayStorage {
  const RelayStorage();

  static const _storage = FlutterSecureStorage();

  static const _keys = [
    'apiBaseUrl',
    'pairingId',
    'deviceToken',
    'mobileDeviceName',
    'desktopDeviceName',
  ];

  Future<RelayCredentials?> load() async {
    final values = <String, String>{};
    for (final key in _keys) {
      final value = await _storage.read(key: key);
      if (value != null) {
        values[key] = value;
      }
    }

    return RelayCredentials.fromStorage(values);
  }

  Future<void> save(RelayCredentials credentials) async {
    for (final entry in credentials.toStorage().entries) {
      await _storage.write(key: entry.key, value: entry.value);
    }
  }

  Future<void> clear() async {
    for (final key in _keys) {
      await _storage.delete(key: key);
    }
  }
}
