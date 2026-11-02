<?php
// SPDX-License-Identifier: GPL-3.0-or-later
namespace local_filesharing\external;
defined('MOODLE_INTERNAL') || die();
class catalogue extends \core_external\external_api {
    public static function execute_parameters(): \core_external\external_function_parameters {
        return new \core_external\external_function_parameters([
            'contextid' => new \core_external\external_value(PARAM_INT, 'Editor context'),
            'action' => new \core_external\external_value(PARAM_ALPHA, 'list, folders, link or usage'),
            'query' => new \core_external\external_value(PARAM_RAW, 'Bounded JSON query', VALUE_DEFAULT, '{}'),
            'resourceid' => new \core_external\external_value(PARAM_ALPHANUMEXT, 'Resource UUID', VALUE_DEFAULT, ''),
        ]);
    }
    public static function execute(int $contextid, string $action, string $query = '{}', string $resourceid = ''): string {
        $params = self::validate_parameters(self::execute_parameters(), compact('contextid', 'action', 'query', 'resourceid'));
        require_sesskey();
        self::validate_context(\context::instance_by_id($params['contextid']));
        require_capability('local/filesharing:access', \context_system::instance());
        if (strlen($query) > 4096 || !in_array($action, ['list', 'folders', 'link', 'usage'])) {
            throw new \invalid_parameter_exception('Invalid catalogue request.');
        }
        $values = json_decode($query, true, 8, JSON_THROW_ON_ERROR);
        if (!is_array($values)) {
            throw new \invalid_parameter_exception('Invalid query.');
        }
        $result = \local_filesharing\bridge::catalogue($action, $values, $resourceid ?: null, $contextid);
        return json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    public static function execute_returns(): \core_external\external_value {
        return new \core_external\external_value(PARAM_RAW, 'JSON catalogue result, containing no API credential.');
    }
}
