<?php
// SPDX-License-Identifier: GPL-3.0-or-later
namespace local_filesharing\task;
defined('MOODLE_INTERNAL') || die();
class cleanup extends \core\task\scheduled_task {
    public function get_name(): string {
        return get_string('cleanup', 'local_filesharing');
    }
    public function execute(): void {
        global $DB;
        foreach (['local_filesharing_code', 'local_filesharing_nonce'] as $table) {
            $DB->delete_records_select($table, 'expires < :now', ['now' => time()]);
        }
    }
}
