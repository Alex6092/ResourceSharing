<?php
// SPDX-License-Identifier: GPL-3.0-or-later
defined('MOODLE_INTERNAL') || die();
if ($hassiteconfig) {
    $settings = new admin_settingpage('local_filesharing', get_string('pluginname', 'local_filesharing'));
    $ADMIN->add('localplugins', $settings);
    $settings->add(new admin_setting_configtext('local_filesharing/apporigin', get_string('apporigin', 'local_filesharing'),
        get_string('apporigin_desc', 'local_filesharing'), '', PARAM_URL));
    $settings->add(new admin_setting_configtext('local_filesharing/clientid', get_string('clientid', 'local_filesharing'),
        '', 'mprovifilesharing', PARAM_ALPHANUMEXT));
    $settings->add(new admin_setting_configtext('local_filesharing/keyid', get_string('keyid', 'local_filesharing'), '', 'v1', PARAM_ALPHANUMEXT));
    foreach (['sharedsecret', 'catalogsecret'] as $key) {
        $settings->add(new admin_setting_configpasswordunmask('local_filesharing/' . $key, get_string($key, 'local_filesharing'),
            get_string('secret_desc', 'local_filesharing'), ''));
    }
    $settings->add(new admin_setting_configcheckbox('local_filesharing/allowinsecure', get_string('allowinsecure', 'local_filesharing'),
        get_string('allowinsecure_desc', 'local_filesharing'), 0));
}
