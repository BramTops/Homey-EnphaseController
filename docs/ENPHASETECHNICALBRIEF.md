# Accessing IQ Gateway Local APIs or Local UI with Token-Based Authentication

**Technical Brief**  
*© 2023 Enphase Energy Inc. All rights reserved. (January 2023)*

---

## Table of Contents
- [1. Overview](#1-overview)
- [2. Generating the Token](#2-generating-the-token)
  - [Obtaining a Token via Web UI](#obtaining-a-token-via-web-ui)
  - [Obtaining a Token Programmatically via URL](#obtaining-a-token-programmatically-via-url)
    - [Shell Script-Based Token Retrieval](#shell-script-based-token-retrieval)
    - [Python Script-Based Token Retrieval](#python-script-based-token-retrieval)
- [3. Accessing the IQ Gateway Using a Token](#3-accessing-the-iq-gateway-using-a-token)
  - [Access the IQ Gateway Local UI](#access-the-iq-gateway-local-ui)
  - [Access the IQ Gateway APIs](#access-the-iq-gateway-apis)
- [Appendix: Local REST API Specifications](#appendix-local-rest-api-specifications)
  - [Getting Meter Details](#getting-meter-details)
  - [Getting Meter Readings](#getting-meter-readings)
  - [Getting Reported Inverter Production Data](#getting-reported-inverter-production-data)
  - [Getting Meter's Live Data](#getting-meters-live-data)
  - [Getting Power Consumption Data](#getting-power-consumption-data)

---

## 1. Overview

At Enphase, we create high-quality solutions that meet the highest security standards. Several of our installers and homeowners use local APIs or the local UI on the IQ Gateway to access data. In the past, these interfaces were protected by conventional password-based authentication. 

With IQ Gateway software version `7.0.x` or higher, the local UI and APIs require cryptographic token-based authentication to improve security. This technical brief explains:
* How to obtain a token for your IQ Gateway.
* How to access the IQ Gateway local UI and APIs using the token.

---

## 2. Generating the Token

This section describes the methods to generate a unique token that can then be used to access the IQ Gateway local interfaces.

### Obtaining a Token via Web UI

This method is useful when the user requires a one-time use token or does not require a programmatic way of token generation.

1. In the browser address window, navigate to [https://entrez.enphaseenergy.com](https://entrez.enphaseenergy.com).
2. Click **Login** and enter your Enphase App credentials.
3. Select your system name and IQ Gateway serial number.
   * If your Enphase Cloud login is associated with multiple systems or if the system has multiple IQ Gateways, select the system and the serial number of the IQ Gateway which requires access via the local API in the **Select System** and **Select Gateway** drop-downs respectively.
   * The system name and IQ Gateway serial number can be obtained from the Enphase App:
     * Navigate to **Menu (bottom right corner) -> Systems -> Devices -> Gateway**. 
     * The serial number is specified under the corresponding IQ Gateway with the label **SN:**.
4. Click **Create access token** to generate the token.
5. Copy and paste the token into your home automation setup or your browser to access the local UI. Save the token securely for future use. Refer to the [Accessing the IQ Gateway Using a Token](#3-accessing-the-iq-gateway-using-a-token) section for detailed steps.

> [!NOTE]
> Tokens are valid for a finite duration:
> * **System Owner:** Token is valid for **1 year**.
> * **Installer:** Token is valid for **12 hours**.
>
> If the credentials used belong to an installer who is also a system owner (i.e., a self-installer), the Web UI-based token retrieval will yield a token valid for **12 hours**. The owner can contact Enphase customer support to change their credentials from installer to system owner. Alternately, the owner can use the programmatic token retrieval method outlined below.

---

### Obtaining a Token Programmatically via URL

For users who want to retrieve a token programmatically, Enphase provides a URL to retrieve a token along with details about its validity duration.

To construct the token retrieval URL for the IQ Gateway:
1. Log in to Enphase Cloud ([https://enlighten.enphaseenergy.com](https://enlighten.enphaseenergy.com)) with the system owner Enphase credentials.
2. Navigate to the following URL in your web browser:
   ```
   https://enlighten.enphaseenergy.com/entrez-auth-token?serial_num=<IQ_Gateway_serial_number>
   ```
   *Replace `<IQ_Gateway_serial_number>` with the serial number of the specific IQ Gateway.*
   
   The IQ Gateway serial number can be obtained from the Enphase App under **Menu (bottom right corner) -> Systems -> Devices -> Gateway**. The serial number is specified under the corresponding IQ Gateway with the label **SN:**.

When the token retrieval URL is accessed via a web browser, the browser performs an HTTP `GET` request. The response contains the token as well as the expected expiry date and time in UNIX epoch timestamp format.

The following examples demonstrate how to retrieve the token programmatically using either a Shell or Python script.

#### Shell Script-Based Token Retrieval

```bash
user='<UserName>'
password='<Password>'
envoy_serial='<Envoy_Serial_No>'

# Step 1: Login to Enphase Cloud to get a session ID
session_id=$(curl -s -X POST "https://enlighten.enphaseenergy.com/login/login.json" \
  -F "user[email]=$user" \
  -F "user[password]=$password" | jq -r ".session_id")

# Step 2: Retrieve the access token using the session ID
web_token=$(curl -s -X POST "https://entrez.enphaseenergy.com/tokens" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\": \"$session_id\", \"serial_num\": \"$envoy_serial\", \"username\": \"$user\"}")
```

> [!NOTE]
> In the above Shell script, make sure to replace:
> * `<Envoy_Serial_No>` with your specific IQ Gateway serial number.
> * `<UserName>` and `<Password>` with your system owner credentials.
>
> The variable `$web_token` will contain the retrieved access token.

#### Python Script-Based Token Retrieval

```python
import json
import requests

user = '<UserName>'
password = '<Password>'
envoy_serial = '<Envoy_Serial_No>'

# Step 1: Login to Enphase Cloud to get a session ID
login_data = {
    'user[email]': user,
    'user[password]': password
}
response = requests.post('https://enlighten.enphaseenergy.com/login/login.json', data=login_data)
response_data = response.json()
session_id = response_data['session_id']

# Step 2: Retrieve the access token using the session ID
token_data = {
    'session_id': session_id,
    'serial_num': envoy_serial,
    'username': user
}
token_response = requests.post('https://entrez.enphaseenergy.com/tokens', json=token_data)
token_raw = token_response.text
```

> [!NOTE]
> In the above Python script, make sure to replace:
> * `<Envoy_Serial_No>` with your specific IQ Gateway serial number.
> * `<UserName>` and `<Password>` with your system owner credentials.
>
> The variable `token_raw` will contain the retrieved access token.

---

## 3. Accessing the IQ Gateway Using a Token

Once a token is obtained, the IQ Gateway local UI or the local APIs can be accessed using this token.

### Access the IQ Gateway Local UI

1. Connect your computer or mobile device to the same Local Area Network (LAN) as the IQ Gateway.
2. Check if the Gateway has an LCD display:
   * **If yes:** This is a legacy Gateway and does not require token-based authentication.
   * **If no:** Enter `http://envoy.local/` into your web browser. If there are additional Gateway units on the network, they can be accessed at:
     * `http://envoy-2.local`
     * `http://envoy-3.local`, etc.
3. The IQ Gateway uses a self-signed certificate. If a browser warning is shown, click **Advanced** -> **Continue to <ip_addr_or_hostname> (unsafe)**. You will be redirected to the IQ Gateway authentication page.
4. Dismiss any error popups that may appear.
   * **Online Path:** If you are online, click **Login with Enphase** and enter your system owner credentials. Cloud authentication will occur automatically, and you will be redirected to the IQ Gateway page (the token is not required).
   * **Offline Path:** If the device you are using is offline, proceed to Step 5.
5. Paste the generated token and click **Submit**. Once verified, the IQ Gateway home screen will load in your browser.

---

### Access the IQ Gateway APIs

The IQ Gateway local APIs can be queried using `curl` commands by passing the token in the `Authorization` header.

1. Connect your computer to the same LAN as the IQ Gateway.
2. Verify connectivity by executing a `ping` command to the IQ Gateway. If successful, proceed.
3. Use the following `curl` command structure to query the APIs:

```bash
curl -f -k -H 'Accept: application/json' -H 'Authorization: Bearer <token_code>' -X <HTTP_METHOD> <API_URL>
```

**Common Curl Flags:**
* `-k`: Allows connections to endpoints using self-signed TLS certificates.
* `-H`: Attaches headers, such as the `Authorization` bearer token and `Accept` header.
* `-X`: Specifies the HTTP request method (e.g., `GET`).
* `-f`: Fails silently on server errors (useful for debugging redirects/authentication issues).
* `-L`: Follows HTTP redirects.

**Example Request:**
```bash
curl -f -k -H 'Accept: application/json' -H 'Authorization: Bearer eyJraWQiOi...' -X GET https://<IQ_Gateway_IP>/api/v1/production/inverters
```

The token is valid for one year for system owners. A new token must be generated upon expiry.

#### Supported Local REST APIs

| API Name | Endpoint URL | Description |
| :--- | :--- | :--- |
| **Meter Details** | `GET https://{IQ_Gateway_IP}/ivp/meters` | Returns meter status, type, and number of phase measurements. |
| **Meter Readings** | `GET https://{IQ_Gateway_IP}/ivp/meters/readings` | Returns active/reactive/apparent energy measurements from production, storage, and consumption CTs (subject to hardware availability). Updates every 5 minutes. |
| **Inverter Production Data** | `GET https://{IQ_Gateway_IP}/api/v1/production/inverters` | Returns maximum and last reported active power production of each available microinverter. Updates every 5 minutes. |
| **Meter's Live Data** | `GET https://{IQ_Gateway_IP}/ivp/livedata/status` | Returns real-time meter readings, system tasks, and connection status. |
| **Load Consumption Data** | `GET https://{IQ_Gateway_IP}/ivp/meters/reports/consumption` | Returns active/reactive/apparent power consumption of the load circuits. Updates every 5 minutes. |

---

## Appendix: Local REST API Specifications

### Getting Meter Details

* **Endpoint:** `GET https://{IQ_Gateway_IP}/ivp/meters`
* **Description:** Returns meter status, type, and phase count.

#### Sample Response
```json
[
  {
    "eid": 704643328,
    "state": "enabled",
    "measurementType": "production",
    "phaseMode": "split",
    "phaseCount": 2,
    "meteringStatus": "normal",
    "statusFlags": []
  },
  {
    "eid": 704643584,
    "state": "enabled",
    "measurementType": "net-consumption",
    "phaseMode": "split",
    "phaseCount": 2,
    "meteringStatus": "normal",
    "statusFlags": []
  }
]
```

---

### Getting Meter Readings

* **Endpoint:** `GET https://{IQ_Gateway_IP}/ivp/meters/readings`
* **Description:** Returns production, storage, and consumption CT measurements. This data updates every 5 minutes.

#### Sample Response
```json
[
  {
    "eid": 704643328,
    "timestamp": 1654218661,
    "actEnergyDlvd": 1608426.912,
    "actEnergyRcvd": 4.923,
    "apparentEnergy": 1648123.109,
    "reactEnergyLagg": 52600.292,
    "reactEnergyLead": 19013.342,
    "instantaneousDemand": 132.118,
    "activePower": 132.118,
    "apparentPower": 5328.778,
    "reactivePower": -5328.778,
    "pwrFactor": 0.025,
    "voltage": 246.377,
    "current": 43.257,
    "freq": 59.188,
    "channels": [
      {
        "eid": 1778385169,
        "timestamp": 1654218661,
        "actEnergyDlvd": 803639.138,
        "actEnergyRcvd": 2.650,
        "apparentEnergy": 823442.481,
        "reactEnergyLagg": 26264.291,
        "reactEnergyLead": 9545.452,
        "instantaneousDemand": 66.037,
        "activePower": 66.037,
        "apparentPower": 2663.476,
        "reactivePower": -2663.476,
        "pwrFactor": 0.025,
        "voltage": 123.184,
        "current": 21.622,
        "freq": 59.188
      },
      {
        "eid": 1778385170,
        "timestamp": 1654218661,
        "actEnergyDlvd": 804787.774,
        "actEnergyRcvd": 2.273,
        "apparentEnergy": 824680.628,
        "reactEnergyLagg": 26336.001,
        "reactEnergyLead": 9467.890,
        "instantaneousDemand": 66.082,
        "activePower": 66.082,
        "apparentPower": 2665.302,
        "reactivePower": -2665.302,
        "pwrFactor": 0.025,
        "voltage": 123.193,
        "current": 21.635,
        "freq": 59.188
      },
      {
        "eid": 1778385171,
        "timestamp": 1654218661,
        "actEnergyDlvd": 0.000,
        "actEnergyRcvd": 0.000,
        "apparentEnergy": 0.000,
        "reactEnergyLagg": 0.000,
        "reactEnergyLead": 0.000,
        "instantaneousDemand": 0.000,
        "activePower": 0.000,
        "apparentPower": 0.000,
        "reactivePower": 0.000,
        "pwrFactor": 0.000,
        "voltage": 0.000,
        "current": 0.000,
        "freq": 59.188
      }
    ]
  },
  {
    "eid": 704643584,
    "timestamp": 1654218661,
    "actEnergyDlvd": 48540.732,
    "actEnergyRcvd": 1244797.861,
    "apparentEnergy": 1332629.594,
    "reactEnergyLagg": 13955.857,
    "reactEnergyLead": 30823.381,
    "instantaneousDemand": -0.000,
    "activePower": -0.000,
    "apparentPower": 34.831,
    "reactivePower": -0.000,
    "pwrFactor": 0.000,
    "voltage": 246.338,
    "current": 0.283,
    "freq": 59.188,
    "channels": [
      {
        "eid": 1778385425,
        "timestamp": 1654218661,
        "actEnergyDlvd": 24176.961,
        "actEnergyRcvd": 600344.235,
        "apparentEnergy": 644044.993,
        "reactEnergyLagg": 5391.081,
        "reactEnergyLead": 15459.001,
        "instantaneousDemand": -0.000,
        "activePower": -0.000,
        "apparentPower": 16.858,
        "reactivePower": -0.000,
        "pwrFactor": 0.000,
        "voltage": 123.152,
        "current": 0.137,
        "freq": 59.188
      },
      {
        "eid": 1778385426,
        "timestamp": 1654218661,
        "actEnergyDlvd": 24363.771,
        "actEnergyRcvd": 644453.626,
        "apparentEnergy": 688584.601,
        "reactEnergyLagg": 8564.776,
        "reactEnergyLead": 15364.380,
        "instantaneousDemand": -0.000,
        "activePower": -0.000,
        "apparentPower": 17.973,
        "reactivePower": -0.000,
        "pwrFactor": 0.000,
        "voltage": 123.186,
        "current": 0.146,
        "freq": 59.188
      },
      {
        "eid": 1778385427,
        "timestamp": 1654218661,
        "actEnergyDlvd": 129399.711,
        "actEnergyRcvd": 93791.210,
        "apparentEnergy": 242548.385,
        "reactEnergyLagg": 15196.459,
        "reactEnergyLead": 10272.271,
        "instantaneousDemand": 0.000,
        "activePower": 0.000,
        "apparentPower": 2697.761,
        "reactivePower": 2697.761,
        "pwrFactor": 0.000,
        "voltage": 123.175,
        "current": 21.902,
        "freq": 59.188
      }
    ]
  },
  {
    "eid": 704643840,
    "timestamp": 1654218661,
    "actEnergyDlvd": 258799.422,
    "actEnergyRcvd": 187582.421,
    "apparentEnergy": 485096.770,
    "reactEnergyLagg": 30392.918,
    "reactEnergyLead": 20544.543,
    "instantaneousDemand": 0.000,
    "activePower": 0.000,
    "apparentPower": 5395.521,
    "reactivePower": 5395.521,
    "pwrFactor": 0.000,
    "voltage": 246.351,
    "current": 43.804,
    "freq": 59.188,
    "channels": [
      {
        "eid": 1778385681,
        "timestamp": 1654218661,
        "actEnergyDlvd": 129399.711,
        "actEnergyRcvd": 93791.210,
        "apparentEnergy": 242548.385,
        "reactEnergyLagg": 15196.459,
        "reactEnergyLead": 10272.271,
        "instantaneousDemand": 0.000,
        "activePower": 0.000,
        "apparentPower": 2697.761,
        "reactivePower": 2697.761,
        "pwrFactor": 0.000,
        "voltage": 123.175,
        "current": 21.902,
        "freq": 59.188
      },
      {
        "eid": 1778385682,
        "timestamp": 1654218661,
        "actEnergyDlvd": 129399.711,
        "actEnergyRcvd": 93791.210,
        "apparentEnergy": 242548.385,
        "reactEnergyLagg": 15196.459,
        "reactEnergyLead": 10272.271,
        "instantaneousDemand": 0.000,
        "activePower": 0.000,
        "apparentPower": 2697.761,
        "reactivePower": 2697.761,
        "pwrFactor": 0.000,
        "voltage": 123.175,
        "current": 21.902,
        "freq": 59.188
      },
      {
        "eid": 1778385683,
        "timestamp": 1654218661,
        "actEnergyDlvd": 0.000,
        "actEnergyRcvd": 0.000,
        "apparentEnergy": 0.000,
        "reactEnergyLagg": 0.000,
        "reactEnergyLead": 0.000,
        "instantaneousDemand": 0.000,
        "activePower": 0.000,
        "apparentPower": 0.000,
        "reactivePower": 0.000,
        "pwrFactor": 0.000,
        "voltage": 0.000,
        "current": 0.000,
        "freq": 59.188
      }
    ]
  }
]
```

---

### Getting Reported Inverter Production Data

* **Endpoint:** `GET https://{IQ_Gateway_IP}/api/v1/production/inverters`
* **Description:** Returns maximum and last reported active power production of each available microinverter. Updates every 5 minutes.

#### Sample Response
```json
[
  {
    "serialNumber": "121935144671",
    "lastReportDate": 1654171836,
    "devType": 1,
    "lastReportWatts": 15,
    "maxReportWatts": 38
  },
  {
    "serialNumber": "121935144623",
    "lastReportDate": 1654171766,
    "devType": 1,
    "lastReportWatts": 5,
    "maxReportWatts": 5
  }
]
```

---

### Getting Meter's Live Data

* **Endpoint:** `GET https://{IQ_Gateway_IP}/ivp/livedata/status`
* **Description:** Returns live data status, tasks, and system counters.

#### Sample Response
```json
{
  "connection": {
    "mqtt_state": "connected",
    "prov_state": "configured",
    "auth_state": "ok",
    "sc_stream": "enabled",
    "sc_debug": "enabled"
  },
  "meters": {
    "last_update": 1654221647,
    "soc": 100,
    "main_relay_state": 0,
    "gen_relay_state": 5,
    "backup_bat_mode": 1,
    "backup_soc": 10,
    "is_split_phase": 1,
    "phase_count": 0,
    "enc_agg_soc": 100,
    "enc_agg_energy": 24800,
    "acb_agg_soc": 0,
    "acb_agg_energy": 0,
    "pv": {
      "agg_p_mw": 329549,
      "agg_s_mva": 329549,
      "agg_p_ph_a_mw": 329549,
      "agg_p_ph_b_mw": 0,
      "agg_p_ph_c_mw": 0,
      "agg_s_ph_a_mva": 329549,
      "agg_s_ph_b_mva": 0,
      "agg_s_ph_c_mva": 0
    },
    "storage": {
      "agg_p_mw": -220800,
      "agg_s_mva": -559446,
      "agg_p_ph_a_mw": -220800,
      "agg_p_ph_b_mw": 0,
      "agg_p_ph_c_mw": 0,
      "agg_s_ph_a_mva": -559446,
      "agg_s_ph_b_mva": 0,
      "agg_s_ph_c_mva": 0
    },
    "grid": {
      "agg_p_mw": 0,
      "agg_s_mva": 0,
      "agg_p_ph_a_mw": 0,
      "agg_p_ph_b_mw": 0,
      "agg_p_ph_c_mw": 0,
      "agg_s_ph_a_mva": 0,
      "agg_s_ph_b_mva": 0,
      "agg_s_ph_c_mva": 0
    },
    "load": {
      "agg_p_mw": 108749,
      "agg_s_mva": -229897,
      "agg_p_ph_a_mw": 108749,
      "agg_p_ph_b_mw": 0,
      "agg_p_ph_c_mw": 0,
      "agg_s_ph_a_mva": -229897,
      "agg_s_ph_b_mva": 0,
      "agg_s_ph_c_mva": 0
    },
    "generator": {
      "agg_p_mw": 0,
      "agg_s_mva": 0,
      "agg_p_ph_a_mw": 0,
      "agg_p_ph_b_mw": 0,
      "agg_p_ph_c_mw": 0,
      "agg_s_ph_a_mva": 0,
      "agg_s_ph_b_mva": 0,
      "agg_s_ph_c_mva": 0
    }
  },
  "tasks": {
    "task_id": 27672012,
    "timestamp": 1654219883
  },
  "counters": {
    "main_CfgLoad": 1,
    "main_CfgChanged": 1,
    "main_taskUpdate": 62,
    "MqttClient_publish": 10260,
    "MqttClient_live_debug": 190,
    "MqttClient_respond": 260,
    "MqttClient_msgarrvd": 130,
    "MqttClient_create": 13,
    "MqttClient_setCallbacks": 13,
    "MqttClient_connect": 13,
    "MqttClient_connect_err": 5,
    "MqttClient_connect_Err": 5,
    "MqttClient_subscribe": 8,
    "SSL_Keys_Create": 13,
    "sc_hdlDataPub": 9440,
    "sc_SendStreamCtrl": 72,
    "sc_SendDemandRspCtrl": 65517,
    "rest_Meters": 7,
    "rest_Status": 579
  }
}
```

---

### Getting Power Consumption Data

* **Endpoint:** `GET https://{IQ_Gateway_IP}/ivp/meters/reports/consumption`
* **Description:** Returns power consumption information of the load circuits. Updates every 5 minutes.

#### Sample Response
```json
[
  {
    "createdAt": 1654625079,
    "reportType": "net-consumption",
    "cumulative": {
      "currW": 119.423,
      "actPower": 119.423,
      "apprntPwr": 105.678,
      "reactPwr": -261.046,
      "whDlvdCum": 43110.122,
      "whRcvdCum": 0.000,
      "varhLagCum": -25071.856,
      "varhLeadCum": 35895.778,
      "vahCum": 192725.807,
      "rmsVoltage": 241.427,
      "rmsCurrent": 0.875,
      "pwrFactor": 1.00,
      "freqHz": 60.00
    },
    "lines": [
      {
        "currW": 56.672,
        "actPower": 56.672,
        "apprntPwr": 49.248,
        "reactPwr": -136.579,
        "whDlvdCum": 21051.342,
        "whRcvdCum": 0.000,
        "varhLagCum": -12541.347,
        "varhLeadCum": 18473.849,
        "vahCum": 96511.746,
        "rmsVoltage": 120.673,
        "rmsCurrent": 0.408,
        "pwrFactor": 1.00,
        "freqHz": 60.00
      },
      {
        "currW": 62.751,
        "actPower": 62.751,
        "apprntPwr": 56.430,
        "reactPwr": -124.467,
        "whDlvdCum": 22058.779,
        "whRcvdCum": 0.000,
        "varhLagCum": -12530.509,
        "varhLeadCum": 17421.929,
        "vahCum": 96214.061,
        "rmsVoltage": 120.753,
        "rmsCurrent": 0.467,
        "pwrFactor": 1.00,
        "freqHz": 60.00
      }
    ]
  },
  {
    "createdAt": 1654625079,
    "reportType": "net-consumption",
    "cumulative": {
      "currW": -1905.274,
      "actPower": -1905.274,
      "apprntPwr": -1920.786,
      "reactPwr": -260.398,
      "whDlvdCum": -152327.377,
      "whRcvdCum": 0.000,
      "varhLagCum": 32.752,
      "varhLeadCum": 35951.521,
      "vahCum": 192725.807,
      "rmsVoltage": 241.427,
      "rmsCurrent": -15.912,
      "pwrFactor": -1.00,
      "freqHz": 60.00
    },
    "lines": [
      {
        "currW": -954.876,
        "actPower": -954.876,
        "apprntPwr": -963.431,
        "reactPwr": -136.579,
        "whDlvdCum": -76608.517,
        "whRcvdCum": 0.000,
        "varhLagCum": 16.155,
        "varhLeadCum": 18488.097,
        "vahCum": 96511.746,
        "rmsVoltage": 120.673,
        "rmsCurrent": -7.984,
        "pwrFactor": -1.00,
        "freqHz": 60.00
      },
      {
        "currW": -950.398,
        "actPower": -950.398,
        "apprntPwr": -957.355,
        "reactPwr": -123.819,
        "whDlvdCum": -75718.860,
        "whRcvdCum": 0.000,
        "varhLagCum": 16.598,
        "varhLeadCum": 17463.423,
        "vahCum": 96214.061,
        "rmsVoltage": 120.753,
        "rmsCurrent": -7.928,
        "pwrFactor": -1.00,
        "freqHz": 60.00
      }
    ]
  }
]