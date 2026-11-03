<?php
// SPDX-License-Identifier: GPL-3.0-or-later
defined('MOODLE_INTERNAL') || die();
function xmldb_local_filesharing_install(): void {
    global $DB;
    // Moodle normally registers capabilities after the plugin's install hook.
    // The role created here needs them immediately.
    update_capabilities('local_filesharing');
    $shortname = 'filesharingcontributor';
    $role = $DB->get_record('role', ['shortname' => $shortname]);
    if (!$role) {
        $roleid = create_role(get_string('contributorrole', 'local_filesharing'), $shortname,
            get_string('contributorrole_desc', 'local_filesharing'));
        set_role_contextlevels($roleid, [CONTEXT_SYSTEM]);
        foreach (['viewicon', 'access', 'upload'] as $name) {
            assign_capability('local/filesharing:' . $name, CAP_ALLOW, $roleid, context_system::instance()->id);
        }
        if ($DB->record_exists('capabilities', ['name' => 'repository/filesharing:view'])) {
            assign_capability('repository/filesharing:view', CAP_ALLOW, $roleid, context_system::instance()->id);
        }
        set_config('contributorroleid', $roleid, 'local_filesharing');
    }
}
