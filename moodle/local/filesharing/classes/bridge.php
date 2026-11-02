<?php
// SPDX-License-Identifier: GPL-3.0-or-later
namespace local_filesharing;
defined('MOODLE_INTERNAL') || die();

final class bridge {
    public static function app_origin(): string {
        $value = rtrim((string)get_config('local_filesharing', 'apporigin'), '/');
        $parts = parse_url($value);
        if (!$parts || empty($parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query'])
                || isset($parts['fragment']) || !empty($parts['path'])
                || (!in_array($parts['scheme'] ?? '', ['https']) && !(get_config('local_filesharing', 'allowinsecure') && ($parts['scheme'] ?? '') === 'http'))) {
            throw new \moodle_exception('misconfigured', 'local_filesharing');
        }
        return $value;
    }
    public static function secret(string $key): string {
        $value = (string)get_config('local_filesharing', $key);
        if (!preg_match('/^[0-9a-f]{64,128}$/iD', $value) || strlen($value) % 2 !== 0) {
            throw new \moodle_exception('misconfigured', 'local_filesharing');
        }
        if (get_config('local_filesharing', 'sharedsecret') === get_config('local_filesharing', 'catalogsecret')) {
            throw new \moodle_exception('misconfigured', 'local_filesharing');
        }
        return hex2bin($value);
    }
    public static function signature(string $key, string $path, string $time, string $nonce, string $raw): string {
        return hash_hmac('sha256', implode("\n", ['POST', $path, $time, $nonce, hash('sha256', $raw)]), $key);
    }
    public static function identity(int $userid): array {
        global $CFG, $DB;
        $user = $DB->get_record('user', ['id' => $userid]);
        $active = $user && !$user->deleted && !$user->suspended && $user->confirmed && $user->auth !== 'nologin' && !isguestuser($user);
        $caps = [];
        if ($active) {
            foreach (['viewicon', 'access', 'upload', 'manageothers', 'admin'] as $name) {
                if (has_capability('local/filesharing:' . $name, \context_system::instance(), $user)) {
                    $caps[] = $name;
                }
            }
        }
        return ['issuer' => rtrim($CFG->wwwroot, '/'), 'subject' => (string)$userid,
            'displayName' => $active ? fullname($user) : '', 'active' => (bool)$active, 'capabilities' => $caps];
    }
    public static function catalogue(string $action, array $query = [], ?string $resourceid = null, ?int $contextid = null): array {
        global $USER;
        require_login();
        require_capability('local/filesharing:access', \context_system::instance());
        $path = '/api/v1/integrations/moodle/catalogue';
        $body = ['subject' => (string)$USER->id, 'action' => $action, 'query' => (object)$query];
        if ($resourceid !== null) {
            if (!preg_match('/^[0-9a-f-]{36}$/D', $resourceid)) {
                throw new \invalid_parameter_exception('Invalid resource ID.');
            }
            $body['resourceId'] = $resourceid;
        }
        if ($contextid !== null) {
            $body['contextId'] = (string)$contextid;
        }
        $raw = json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $time = (string)time();
        $nonce = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $curl = new \curl();
        $curl->setHeader(['Content-Type: application/json', 'X-Client-Id: ' . get_config('local_filesharing', 'clientid'),
            'X-Key-Id: ' . get_config('local_filesharing', 'keyid'), 'X-Timestamp: ' . $time, 'X-Nonce: ' . $nonce,
            'X-Signature: ' . self::signature(self::secret('catalogsecret'), $path, $time, $nonce, $raw)]);
        $result = $curl->post(self::app_origin() . $path, $raw, [
            'CURLOPT_TIMEOUT' => 15, 'CURLOPT_CONNECTTIMEOUT' => 5,
            'CURLOPT_SSL_VERIFYPEER' => true, 'CURLOPT_SSL_VERIFYHOST' => 2, 'CURLOPT_FOLLOWLOCATION' => false,
        ]);
        if ($curl->get_errno() || ($curl->get_info()['http_code'] ?? 0) !== 200 || strlen($result) > 1048576) {
            throw new \moodle_exception('apifailed', 'local_filesharing');
        }
        $value = json_decode($result, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($value)) {
            throw new \moodle_exception('apifailed', 'local_filesharing');
        }
        return $value;
    }
}
