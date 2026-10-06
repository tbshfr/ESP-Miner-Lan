import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { getHttpErrorMessage } from 'src/app/utils/error-handler';
import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';
import { finalize, switchMap, takeUntil } from 'rxjs/operators';
import { BehaviorSubject, Observable, Subject, of } from 'rxjs';
import { DialogService } from 'src/app/services/dialog.service';
import { LoadingService } from 'src/app/services/loading.service';
import { LiveDataService } from 'src/app/services/live-data.service';
import { SystemApiService } from 'src/app/services/system.service';
import { WifiNetwork } from 'src/app/generated/models';
import { first } from 'rxjs/operators';
import { ISystemUpdateResponse } from 'src/models/ISystemUpdateResponse';

interface EthernetStatus {
  networkMode: string;
  ethAvailable: number;
  ethLinkUp: number;
  ethConnected: number;
  ethIPv4: string;
  ethMac: string;
  ethUseDHCP: number;
  ethStaticIP: string;
  ethGateway: string;
  ethSubnet: string;
  ethDNS: string;
}

@Component({
    selector: 'app-network-edit',
    templateUrl: './network.edit.component.html',
    styleUrls: ['./network.edit.component.scss'],
    standalone: false
})
export class NetworkEditComponent implements OnInit, OnDestroy {
  private formSubject = new BehaviorSubject<FormGroup | null>(null);
  public form$: Observable<FormGroup | null> = this.formSubject.asObservable();

  public form!: FormGroup;
  public ethernetForm!: FormGroup;
  public savedChanges: boolean = false;
  public scanning: boolean = false;

  // WiFi status
  public wifiIpv4: string = '';
  public wifiStatus: string = '';
  public wifiRSSI: number = -128;

  // Ethernet status
  public networkMode: string = 'wifi';
  public ethAvailable: boolean = false;
  public ethLinkUp: boolean = false;
  public ethConnected: boolean = false;
  public ethIPv4: string = '0.0.0.0';
  public ethMac: string = '00:00:00:00:00:00';

  public readonly ethStaticFields = [
    { name: 'ethStaticIP', label: 'Static IP', placeholder: '192.168.1.121' },
    { name: 'ethGateway', label: 'Gateway', placeholder: '192.168.1.1' },
    { name: 'ethSubnet', label: 'Subnet Mask', placeholder: '255.255.255.0' },
    { name: 'ethDNS', label: 'DNS Server', placeholder: '8.8.8.8' },
  ];

  private destroy$ = new Subject<void>();

  @Input() uri = '';

  constructor(
    private fb: FormBuilder,
    private systemService: SystemApiService,
    private liveDataService: LiveDataService,
    private toastr: ToastrService,
    private loadingService: LoadingService,
    private http: HttpClient,
    private dialogService: DialogService
  ) {

  }

  private ipAddressValidator(control: any): {[key: string]: any} | null {
    if (!control.value) {
      return null;
    }
    const ipPattern = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipPattern.test(control.value)) {
      return { 'invalidIp': true };
    }
    return null;
  }

  ngOnInit(): void {
    // Initialize ethernet form immediately with defaults to ensure its always available
    this.ethernetForm = this.fb.group({
      networkMode: ['wifi'],
      ethUseDHCP: [true],
      ethStaticIP: ['192.168.1.121', [Validators.required, this.ipAddressValidator.bind(this)]],
      ethGateway: ['192.168.1.1', [Validators.required, this.ipAddressValidator.bind(this)]],
      ethSubnet: ['255.255.255.0', [Validators.required, this.ipAddressValidator.bind(this)]],
      ethDNS: ['8.8.8.8', [Validators.required, this.ipAddressValidator.bind(this)]]
    });

    this.liveDataService.info$
      .pipe(first(), takeUntil(this.destroy$), this.loadingService.lockUIUntilComplete())
      .subscribe(info => {
        this.form = this.fb.group({
          hostname: [info.hostname, [Validators.required]],
          ssid: [info.ssid, [Validators.required]],
          wifiPass: ['*****'],
          useNTP: [info.useNTP],
        });
        this.formSubject.next(this.form);

        // Load Ethernet configuration
        this.loadEthernetConfig();
      });

    // Keep network status up to date
    this.liveDataService.info$
      .pipe(takeUntil(this.destroy$))
      .subscribe(info => {
        // Update WiFi status
        this.wifiIpv4 = info.ipv4 || '';
        this.wifiStatus = info.wifiStatus || '';
        this.wifiRSSI = info.wifiRSSI || -128;

        // Update Ethernet status
        this.networkMode = info.networkMode || 'wifi';
        this.ethAvailable = !!info.ethAvailable;
        this.ethLinkUp = !!info.ethLinkUp;
        this.ethConnected = !!info.ethConnected;
        this.ethIPv4 = info.ethIPv4 || '0.0.0.0';
        this.ethMac = info.ethMac || '00:00:00:00:00:00';
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private loadEthernetConfig(): void {
    this.http.get<EthernetStatus>(`${this.uri}/api/system/ethernet/status`)
      .subscribe({
        next: (status) => {
          this.ethernetForm.patchValue({
            networkMode: status.networkMode || 'wifi',
            ethUseDHCP: !!status.ethUseDHCP,
            ethStaticIP: status.ethStaticIP || '192.168.1.121',
            ethGateway: status.ethGateway || '192.168.1.1',
            ethSubnet: status.ethSubnet || '255.255.255.0',
            ethDNS: status.ethDNS || '8.8.8.8'
          });
          this.ethernetForm.markAsPristine();
        },
        error: (err) => {
          console.error('Failed to load Ethernet config:', err);
          // Keep default values
        }
      });
  }


  public updateSystem() {

    const restartAlreadyPending = this.savedChanges;
    const restartRequired = this.isRestartRequired;
    const form = this.form.getRawValue();

    // Allow an empty Wi-Fi password
    form.wifiPass = form.wifiPass == null ? '' : form.wifiPass;

    if (form.wifiPass === '*****') {
      delete form.wifiPass;
    }

    // Trim SSID to remove any leading/trailing whitespace
    if (form.ssid) {
      form.ssid = form.ssid.trim();
    }

    this.systemService.updateSystem(this.uri, form)
      .pipe(this.loadingService.lockUIUntilComplete())
      .subscribe({
        next: (response: any) => {
           // Check if response contains redirect information (hostname change)
           if (response && response.redirect) {
             const redirectResponse = response as ISystemUpdateResponse;
             if (redirectResponse.redirect) {
               let newHostname: string;
               try {
                 newHostname = new URL(redirectResponse.redirect.url).hostname;
                } catch (error) {
                  console.error('Invalid redirect URL:', redirectResponse.redirect.url, error);
                  this.toastr.error('Failed to redirect due to invalid URL.');
                  return; // Skip redirect on malformed URL
                }
               const redirectUrl = redirectResponse.redirect.url;
               const redirectDelay = redirectResponse.redirect.delay;
               
               this.toastr.success(redirectResponse.redirect.message);
               this.toastr.info(`Redirecting to ${newHostname} in ${Math.ceil(redirectDelay / 1000)} seconds...`);
               
               setTimeout(() => {
                 window.location.href = redirectUrl;
               }, redirectDelay);
             }
             return;
           }

           // Normal success handling
           if (restartRequired) {
             this.toastr.warning('You must restart this device after saving for changes to take effect.');
           }
          this.toastr.success('Saved network settings');
          this.savedChanges = restartAlreadyPending || restartRequired;
          this.form.markAsPristine();
        },
        error: (err: HttpErrorResponse) => {
          this.toastr.error(`Could not save. ${getHttpErrorMessage(err, this.uri)}`);
          this.savedChanges = restartAlreadyPending;
        }
      });
  }

  public updateEthernetConfig() {
    const ethConfig = this.ethernetForm.getRawValue();

    // Shared settings (hostname, time sync) are saved through the regular system endpoint
    const systemUpdate: { [key: string]: any } = {};
    for (const field of ['hostname', 'useNTP']) {
      const control = this.form.get(field);
      if (control?.dirty) {
        systemUpdate[field] = control.value;
      }
    }

    this.http.post(`${this.uri}/api/system/ethernet/config`, ethConfig)
      .pipe(
        switchMap(() => {
          if (Object.keys(systemUpdate).length > 0) {
            return this.systemService.updateSystem(this.uri, systemUpdate);
          }
          return of(null);
        }),
        this.loadingService.lockUIUntilComplete()
      )
      .subscribe({
        next: () => {
          this.toastr.success('Ethernet configuration saved');
          this.toastr.warning('Restart required for changes to take effect');
          this.savedChanges = true;
          this.ethernetForm.markAsPristine();
          this.form.markAsPristine();
        },
        error: (err: HttpErrorResponse) => {
          this.toastr.error(`Could not save Ethernet config. ${getHttpErrorMessage(err, this.uri)}`);
        }
      });
  }

  public switchNetworkMode(mode: string) {
    this.http.post(`${this.uri}/api/system/network/mode`, { networkMode: mode })
      .pipe(this.loadingService.lockUIUntilComplete())
      .subscribe({
        next: () => {
          this.toastr.success(`Switched to ${mode.toUpperCase()} mode`);
          this.toastr.warning('Restart required for network mode change');
          this.networkMode = mode;
          this.savedChanges = true;
        },
        error: (err: HttpErrorResponse) => {
          this.toastr.error(`Could not switch network mode. ${getHttpErrorMessage(err, this.uri)}`);
        }
      });
  }

  // Check if connected to WiFi (not in AP/captive portal mode)
  public isConnectedToWifi(): boolean {
    // Check if WiFi is connected by verifying we have a valid IP address
    return this.wifiIpv4 !== '' &&
           this.wifiIpv4 !== 'Not connected' &&
           this.wifiIpv4 !== '0.0.0.0' &&
           this.wifiStatus === 'Connected!';
  }

  // Check if connected to any network (WiFi or Ethernet)
  public isConnectedToNetwork(): boolean {
    return this.isConnectedToWifi() || this.ethConnected;
  }

  showWifiPassword: boolean = false;
  toggleWifiPasswordVisibility() {
    this.showWifiPassword = !this.showWifiPassword;
  }

  public scanWifi() {
    this.scanning = true;
    this.http.get<{networks: WifiNetwork[]}>('/api/system/wifi/scan')
      .pipe(
        finalize(() => this.scanning = false)
      )
      .subscribe({
        next: (response) => {
          // Sort networks by signal strength (highest first)
          const networks = response.networks.sort((a, b) => b.rssi - a.rssi);

          // filter out poor Wi-Fi connections
          const poorNetworks = networks.filter(network => network.rssi >= -80);

          // Remove duplicate Network Names and show highest signal strength only
          const uniqueNetworks = poorNetworks.reduce((acc, network) => {
            if (!acc[network.ssid] || acc[network.ssid].rssi < network.rssi) {
              acc[network.ssid] = network;
            }
            return acc;
          }, {} as { [key: string]: WifiNetwork });

          // Convert the object back to an array
          const filteredNetworks = Object.values(uniqueNetworks);

          // Create dialog data
          const dialogData = filteredNetworks.map(n => ({
            label: n.ssid,
            rssi: n.rssi,
            value: n.ssid
          }));

          // Show dialog with network list
          this.dialogService.open('Select Wi-Fi Network', dialogData)
            .subscribe((selectedSsid: string) => {
              if (selectedSsid) {
                this.form.patchValue({ ssid: selectedSsid });
                this.form.get('ssid')?.markAsDirty();
              }
            });
        },
        error: (err) => {
          this.toastr.error('Failed to scan Wi-Fi networks');
        }
      });
  }

  public restart() {
    this.systemService.restart()
      .pipe(this.loadingService.lockUIUntilComplete())
      .subscribe({
        next: () => {
          this.toastr.success('Device restarted');
          this.savedChanges = false;
        },
        error: (err: HttpErrorResponse) => {
          this.toastr.error(`Could not restart. ${getHttpErrorMessage(err, this.uri)}`);
        }
      });
  }

  get noRestartFields(): string[] {
    return [
      'hostname'
    ];
  }

  get isRestartRequired(): boolean {
    return Object.entries(this.form.controls)
      .some(([field, control]) => control.dirty && !this.noRestartFields.includes(field));
  }
}
