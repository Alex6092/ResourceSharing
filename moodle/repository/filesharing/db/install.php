<?php
// SPDX-License-Identifier: GPL-3.0-or-later
defined('MOODLE_INTERNAL') || die();
function xmldb_repository_filesharing_install(): void {
    global $DB;
    $roleid = get_config('local_filesharing', 'contributorroleid');
    if ($roleid && $DB->record_exists('role', ['id' => $roleid])) {
        assign_capability('repository/filesharing:view', CAP_ALLOW, $roleid, context_system::instance()->id);
    }
}
