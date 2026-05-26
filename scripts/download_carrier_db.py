import urllib.request
import zipfile
import io
import os
import json
import re

def main():
    url = "https://reports.nanpa.com/public/CoCodeAssignment_Utilized_AllStates_Public.zip"
    dest_json = os.path.join(os.path.dirname(os.path.dirname(__file__)), "us_mobile_prefixes.json")
    
    print(f"📥 Downloading NANPA Central Office Code assignment database from:\n{url}\n")
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as response:
            zip_data = response.read()
            print("✅ Download complete! Processing zip archive...")
    except Exception as e:
        print(f"❌ Failed to download database from NANPA: {e}")
        return

    try:
        with zipfile.ZipFile(io.BytesIO(zip_data)) as z:
            txt_files = [f for f in z.namelist() if f.endswith('.txt')]
            if not txt_files:
                print("❌ Could not find any assignment text files inside the ZIP archive.")
                return
            
            target_file = txt_files[0]
            print(f"📂 Extracting and parsing: {target_file}...")
            
            with z.open(target_file) as f:
                content = f.read().decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"❌ Failed to extract zip archive: {e}")
        return

    lines = content.splitlines()
    print(f"📋 Total raw records found: {len(lines)}")
    
    mobile_prefixes = {}
    total_assigned = 0
    total_mobile = 0
    
    # Wireless indicators in Company/Carrier Name
    wireless_patterns = re.compile(
        r'(wireless|cellular|mobility|pcs|mobile|cellco|telecom.*wireless|bell.*mobility|sprint|t-mobile|cingular|mccaw|omnipoint|aerial)', 
        re.IGNORECASE
    )
    
    for line in lines:
        parts = line.split('\t')
        if len(parts) < 7:
            continue
            
        npa_nxx_raw = parts[1].strip() # NPA-NXX is Column 1
        status = parts[6].strip().upper() # Use (Status) is Column 6
        company_name = parts[3].strip() # Company Name is Column 3
        
        # We only care about assigned active codes
        if status != "AS":
            continue
            
        # Clean the prefix code to a clean 6-digit string, e.g. "907200"
        npa_nxx = npa_nxx_raw.replace('-', '').strip()
        if len(npa_nxx) != 6 or not npa_nxx.isdigit():
            continue
            
        total_assigned += 1
        
        # Check if company name indicates a mobile/wireless carrier
        is_wireless = bool(wireless_patterns.search(company_name))
        
        # Store as 1 (mobile) or 0 (landline) to keep JSON file extremely lightweight
        mobile_prefixes[npa_nxx] = 1 if is_wireless else 0
        if is_wireless:
            total_mobile += 1
            
    if total_assigned == 0:
        print("❌ Error: Processed 0 assigned codes. Delimiter or parsing columns might be incorrect.")
        return
        
    print(f"📊 Processed {total_assigned} assigned codes.")
    print(f"📱 Wireless (Mobile) Prefixes: {total_mobile} ({round(total_mobile/total_assigned * 100, 1)}%)")
    print(f"☎️ Wireline (Landline/VoIP) Prefixes: {total_assigned - total_mobile}")
    
    # Save to dynamic JSON mapping
    with open(dest_json, "w", encoding="utf-8") as f:
        json.dump(mobile_prefixes, f, separators=(',', ':'))
        
    print(f"\n✅ Offline carrier lookup database generated successfully at:\n{dest_json}")
    print(f"💾 File size: {round(os.path.getsize(dest_json) / 1024, 1)} KB")

if __name__ == "__main__":
    main()
